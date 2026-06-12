# Tenon Design System

This file is the single source of truth for Tenon's product UI system —
the **design language** (principles, tokens, materials, rules). It describes the
system as designed, holistically; it is not a mirror of what each release happens
to ship. The **rollout** — current-vs-target gaps, staged PRs, migrations — lives
in [`docs/plans/design-system-rollout.md`](../plans/design-system-rollout.md), so
this document stays a clean design contract rather than an implementation tracker.

It is optimized for agents and implementers reading source context. Product
code remains the authority for real behavior; reference snippets live inline
here when they help avoid ambiguity.

## Product Intent

Tenon should feel like a dense desktop knowledge workspace:

- Quiet neutral chrome.
- Persistent cross-tab sidebar.
- Persistent cross-tab agent dock.
- Central workspace canvas with one or more tiled outliner panels.
- Opaque content panels floating over a translucent chrome deck, in both light
  and dark appearance.
- Outliner content remains the primary visual object.

Avoid marketing-page composition, decorative cards, ornamental color, hidden
scrollbars, and fake product panels. A panel that looks editable in product UI
must be backed by real product state.

## Brand & Design Principles

Tenon's brand is expressed through restraint, not decoration. It should feel like
a calm, dense, native desktop tool whose personality lives in the content and a
single sparing accent — never in re-skinned chrome. These principles are the
"why" behind the tokens; cite them by number when a decision contradicts one.

1. **Native over branded chrome.** Adopt the platform's materials, window
   behavior, controls, and shadows — the OS draws blur, vibrancy, and traffic
   lights better than we can. Brand shows in content and a sparse rose accent,
   not in a custom-themed window.
2. **Content is the hero.** The outliner is the primary visual object; chrome
   recedes behind it (translucent) so the document stays the focus.
3. **Restraint with color.** Functional state (selection, hover, active, primary
   buttons) is neutral. Rose is a rare signal — links, caret, brand marks, small
   status badges — never the everyday active state, and never the system accent.
4. **Density without noise.** Compact, quiet, predictable. No decorative nested
   cards, no ornamental color, no motion for its own sake.
5. **One semantic layer, two themes.** Every value is a token. Light and dark
   differ only by flipping `--ink` plus a few opaque/material literals.
6. **Real over fake.** Never style a surface that is not backed by real product
   state; never fake a platform material or affordance we cannot truly draw.

## Reference Boundary

Tana and nodex are references for density, spacing, surface hierarchy, and
specific outliner interactions. Tenon keeps its own navigation model, command
model, document model, outliner behavior, and agent model.

Use references for:

- Overall density and text rhythm.
- Opaque workspace surfaces over a translucent chrome deck (light and dark).
- Muted controls and low elevation.
- Node/reference/field interaction parity where Tenon owns the same behavior.

Do not copy reference-product scope, navigation entries, fake panels, warm
paper palettes, or feature concepts Tenon does not own.

## Source Map

| Area | Product Sources | Contract |
| --- | --- | --- |
| Shell and tabs | `App.tsx`, `TopBar.tsx`, `WorkspaceTab.tsx`, `useWorkspaceTabs.ts` | Top chrome, tabs, shell layout, and collapse controls. |
| Workspace canvas | `WorkspaceCanvas.tsx`, `WorkspacePanelSurface.tsx`, `ResizeHandle.tsx`, `useResizableLayout.ts` | Real tiled panels, resize slots, ratio fill, local overflow. |
| Outliner panel | `NodePanel.tsx`, `OutlinerView.tsx`, `OutlinerItem.tsx`, `styles/outliner.css` | Title, breadcrumb, tags, rows, fields, references, triggers. |
| Outliner rows | `OutlinerRowShell.tsx`, `RowLeading.tsx`, `RowMarker.tsx`, `RowHost.tsx`, `useOutlinerRowInteraction.ts` | Row geometry, selection, leading markers, chevron behavior. |
| Fields and definitions | `DefinitionConfigPanel.tsx`, `DefinitionConfigControls.tsx`, `DefinitionConfigRowShell.tsx`, `FieldEntryGrid.tsx`, `OutlinerFieldRow.tsx`, `FieldValueOutliner.tsx` | Field rows, field values, and definition configuration. |
| Tags | `AppliedTag.tsx`, `TagBar.tsx`, `tagColors.ts`, `TagSelector.tsx`, `BatchTagSelector.tsx` | Applied tag rendering, tag menus, and batch tag surfaces. |
| Editor and commands | `RichTextEditor.tsx`, `FloatingEditorToolbar.tsx`, `CommandPalette.tsx`, `editorRegistry.ts` | Rich text editing, command palette, toolbar, and trigger overlays. |
| Menus and overlays | `MenuSurface.tsx`, `MenuItem.tsx`, `AnchoredOverlay.tsx`, `Dialog.tsx`, `PopoverList.tsx`, `NodeContextMenu.tsx`, `TriggerPopover.tsx`, `ReferenceSelector.tsx`, `SlashCommandMenu.tsx` | Overlay semantics, positioning, elevation, dismissal, and item rows. |
| Agent dock | `AgentDock.tsx`, `AgentChatPanel.tsx`, `AgentDebugPanel.tsx` | Persistent dock, chat scroll, debug surface, settings entry. |
| Agent messages | `AgentMessageRow.tsx`, `AgentMessageFrame.tsx`, `AgentIdentityAvatar.tsx`, `AgentBranchNavigator.tsx`, `AgentProcessBlock.tsx`, `AgentProcessTimeline.tsx`, `AgentThinkingBlock.tsx`, `AgentToolCallBlock.tsx`, `AgentToolCallDisclosure.tsx` | Messages, speaker identity, metadata details, process disclosure, thinking, tool calls, status slots. |
| Agent composer | `AgentComposer.tsx`, `AgentComposerControls.tsx` | Textarea, attachments, model display/navigation chip, send/stop slot. |
| Attachment rows | `AttachmentRow.tsx`, `BlockNodeRow.tsx`, `inlineFileIcon.tsx` | File attachment block rows, PDF thumbnails, file-kind glyphs, media controls, and safe system-action buttons. |
| Agent settings | `AgentSettingsView.tsx`, `SettingsInsetList.tsx`, `SettingsRowMenu.tsx`, `ProviderConfigWindow.tsx` / `ProviderConfigForm.tsx`, `providerCatalog.tsx`, `styles/settings-*.css` | Standalone settings window: category sidebar + right-pane toolbar title, constrained inset grouped content, per-row `⋯` menu, and the per-provider config as its own native (modal child) window. See "Settings window" below. |
| Primitives | `ButtonControl.tsx`, `CheckboxControl.tsx`, `CheckboxMark.tsx`, `IconButton.tsx`, `SwitchControl.tsx`, `SwitchMark.tsx`, `SelectControl.tsx`, `TextInputControl.tsx`, `NumberInputControl.tsx` | Thin semantic or visual primitives. Behavior remains caller-owned unless the primitive explicitly owns native control semantics. |

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
  --rail-edge: rgb(var(--ink) / 0.10); /* 0.5px inset hairline on the glass rail */

  /* ── Selection & focus = NEUTRAL (Raycast/Finder model). Functional state is
        never the brand colour and never the system accent. ── */
  --selection-bg: var(--fill-3);    /* selected row */
  --selection-soft: var(--fill-2);  /* multi-select / range / hover */
  --focus-ring: rgb(var(--ink) / 0.45);
  --focus-ring-shadow: 0 0 0 2px rgb(var(--ink) / 0.22);
  /* Editor text-selection highlight (::selection): NEUTRAL, not the system
     accent and not rose — a touch stronger than a selected row so glyphs stay
     legible through it. Glyph colour is unchanged under selection. */
  --text-selection-bg: rgb(var(--ink) / 0.14);
  --drop-line: var(--focus-ring); /* neutral drag insertion line */

  /* ── Accent = brand rose, used SPARSELY: links, text caret, brand marks,
        small status badges. Never selection, focus, active rows, or primary
        buttons (those are neutral fills). ── */
  --accent: #f43f5e;
  --accent-strong: #e11d48;
  --link: var(--accent);
  --caret: var(--accent);

  /* ── Status ── */
  --status-success: #3f9e6a;
  --status-success-strong: #3f865d;
  --status-warning: #d99a1c;
  --status-danger: #e5484d;
  --status-danger-muted: #9a3f34;
  --status-info: #3b82c4;

  /* ── Inline code / badge text: a muted brand tint, recognisable but quiet ── */
  --primary-muted-text: color-mix(in srgb, var(--accent) 58%, var(--text-primary));
  --inline-code-bg: rgb(var(--ink) / 0.06);

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
  --outline-primary: inset 0 0 0 1px color-mix(in srgb, var(--accent) 26%, transparent);
  --outline-primary-strong: inset 0 0 0 1px color-mix(in srgb, var(--accent) 58%, var(--separator));
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
  --accent-danger: var(--accent-strong);
  /* NOTE: no --primary alias. It is deliberately absent (see Color & Appearance):
     its name implies a primary-action colour, but it historically mapped to rose
     and silently violated "functional state is neutral". Do not reintroduce it;
     action surfaces use the neutral --fill-* ladder + --focus-ring. */
  --semantic-success: var(--status-success);
  --semantic-success-strong: var(--status-success-strong);
  --semantic-danger-muted: var(--status-danger-muted);
  --semantic-warning: var(--status-warning);
  --semantic-info: var(--status-info);

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
     (~70–80 chars at 16px). Chrome like the breadcrumb hugs the pane edge. */
  --reading-column-max: 720px;

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
    --status-info: #5aa0e0;

    /* inverse chips invert (dark-on-light in light mode → light-on-dark here) */
    --surface-inverse: #e6e6ea;
    --surface-inverse-strong: #f4f4f6;

    /* drop shadows go deeper so elevation still reads on a dark backdrop */
    --overlay-shadow-level-1: 0 8px 22px -12px rgba(0, 0, 0, 0.55), 0 2px 8px -4px rgba(0, 0, 0, 0.40);
    --overlay-shadow-level-2: 0 18px 50px -20px rgba(0, 0, 0, 0.60), 0 6px 18px -10px rgba(0, 0, 0, 0.45);
  }
}
```

### Token Rules

- Product CSS keeps raw hex colors inside token declarations only.
- Component CSS may use `rgba()` or `color-mix()` for alpha states, but the base
  color should come from a token whenever the value is semantic.
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
  top corners (see Components → Agent) rather than a concentric inset.
- **Interactive controls are capsules, not links in the concentric chain (B6).**
  Icon buttons and the composer's send / attach / model controls are *fully
  rounded* via `--radius-pill`: a square control renders as a circle, a wide one
  as a stadium, so every control of the same height shows the same corner arc
  (= half its height) and they line up regardless of which surface they float in.
  The concentric chain governs nested *surfaces*; a control floating inside a
  surface (with padding all around it) does not share that surface's corner, so it
  does NOT derive `parent − inset`. Never give such a control a small
  rounded-square radius — the failure mode is a 2px box sitting next to a circle
  (the composer send/model controls had exactly this bug).
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
- **Functional state is neutral.** Selection, hover, active rows, and primary
  buttons use the neutral `--fill-*` ladder and neutral `--focus-ring` — not the
  brand colour and not the macOS system accent. (Raycast and Finder both keep
  selection and primary buttons neutral; native feel comes from materials,
  layout, and behaviour, not from a coloured selection.) The toggle / checkbox
  **on**-state is the one sanctioned exception: it carries `--semantic-success`
  (the macOS on-switch idiom) with a fixed-white knob / check glyph
  (`--text-on-accent`) in BOTH themes — `--panel-bg` is wrong for the knob/glyph
  because it flips dark in dark mode (a black puck on the green track).
- **Text selection is neutral too.** The editor text-selection highlight
  (`::selection`, `--text-selection-bg`) is a neutral ink alpha — the one place
  the OS would normally paint its system accent, kept neutral for consistency
  with the rest of functional state. It is slightly stronger than a selected row
  so glyphs stay legible; the glyph colour itself does not change under selection.
- **Brand accent is sparse.** `--accent` (rose) appears only in: links
  (`--link`), the text caret (`--caret`), the workspace-root avatar (the single
  in-rail brand mark — there is no separate static app brand header), and small
  status badges. It never paints selection, focus, active rows, or primary
  buttons.
- **Surfaces.** `--bg-window` is the chrome base behind the material;
  `--bg-content` is the opaque content panel; `--bg-elevated` is menus / popovers
  / HUD — in dark mode it is *lighter* than content so floating surfaces read as
  elevated.
- **Status.** `--status-success` (Sage), `--status-warning` (Mustard),
  `--status-info` (Sapphire), `--status-danger`. Status colour is reserved for
  genuine semantic state, not decoration. **It must never leak into interactive
  meaning** — status colours never paint selection, hover, active rows, focus,
  links, or any clickable affordance. In particular `--status-info` (blue) is for
  an *informational status* only; it is not a link, selection, or accent colour,
  and using it as one would read as a smuggled-in system accent (which we
  deliberately avoid). The app has one accent (rose) and one link colour (rose).
- **Dark-mode rules.** Avoid pure `#000`/`#fff`; lean on the alpha-on-ink levels
  and the `#1e1e1e` / `#2a2a2c` / `#2e2e30` surface seeds. Separators and outlines
  invert with `--ink` automatically; drop shadows deepen.
- **Legacy aliases.** `--deck-bg`, `--panel-bg`, `--text-main`, … are aliased onto
  this layer so existing components keep working; migrate to the semantic tokens
  opportunistically.
- **There is no `--primary` token — do not reintroduce it.** Its name implies a
  primary-action colour, but it historically mapped to the rose accent, so every
  surface that read it (many primary buttons, active rows, focus surfaces) stayed
  rose and silently violated "functional state is neutral." Action surfaces use
  the neutral fill ladder — rest transparent or `--fill-1`, hover `--fill-2`,
  pressed `--fill-4`, selected `--fill-3` — and neutral `--focus-ring`. Pre-launch
  means no compatibility burden: the rollout migrates every remaining `--primary`
  / `--accent-brand`-as-action usage in live CSS to the neutral fills and deletes
  the alias outright, rather than keeping a rose shim. The brand colour survives
  only for the sparse accent roles above (links, caret, brand marks, status
  badges).

User-defined tag palette (light-mode values; dark variants are derived by the
tag colour system, not hardcoded here):

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
  and floating controls are also chrome. Backed by the OS — Electron `vibrancy`
  (NSVisualEffectView on macOS; acrylic/mica on Windows later) — with CSS adding
  `backdrop-filter: blur() saturate()` plus a translucent tint (`--material-*`).
  Because the content base extends under them, the rails show the blurred content
  through their material — that *is* the vibrancy.

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
dropped. Legibility never depends on the blur being present.

**Increased contrast.** Honor `prefers-contrast: more` (macOS "Increase
contrast"): strengthen the alpha-on-ink separators and outlines (step the
`--separator` / `--outline-*` ladder up), let materials lean more opaque, and
ensure text clears AA comfortably (approach AAA on primary text). State is still
neutral — contrast is raised by stroke weight, not by introducing colour.

**Inactive window.** When the app loses focus, follow the platform: NSVisualEffectView
already desaturates, and the renderer should match — a `.window-inactive` state
(driven by the BrowserWindow blur/focus events) eases the rail material toward its
opaque seed, softens the selection fill, and quiets the breadcrumb. The OS grays
the traffic lights; brand marks and content stay as-is. Never leave a bright,
"focused-looking" chrome on a backgrounded window — that reads as non-native.

Vibrancy mapping (the window itself uses `sidebar` vibrancy, set in `main.ts`):

| Surface | Electron `vibrancy` | macOS material | CSS tint |
| --- | --- | --- | --- |
| Sidebar rail | `sidebar` | Sidebar | `--material-sidebar` |
| Agent rail | `sidebar` | Sidebar | `--material-sidebar` |
| Menus / popovers | `popover` | Menu / Popover | `--material-popover` |
| Transient HUD / peek | `hud` | HUDWindow | `--bg-elevated` |
| Global launcher window | `hud` | HUDWindow | transparent (functional fills tint the glass) |

There is no separate full-width toolbar material: the top strip is the window's
drag region; over the content base it is transparent, over a rail it is the
rail's own material.

### Typography

Type roles map onto the Foundations font tokens; do not introduce new sizes.

- **Panel title:** `--font-panel-title / --line-panel-title`, weight `600`.
- **Headings:** one large heading size `--font-heading-lg` (18, markdown h1);
  smaller headings reuse `--font-content` (16) and `--font-ui-md` (14) rather
  than a parallel ladder. The panel display title is `--font-panel-title` (24).
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
share a stable visual line, so mixed runs do not change row height. Do not apply
letter-spacing to CJK text.

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
  wide panels — max width `--reading-column-max` (720px, ~70–80 chars at 16px);
  chrome like the breadcrumb hugs the panel's left edge instead.
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
- **Delivery:** a hand-curated **inline-SVG icon set** rendered in the WebView —
  *not* the SF Symbols font. SF Symbols is licensed for system UI only and cannot
  be embedded, so we ship our own SVGs drawn to SF's optical grid (16px box,
  ~1.5px stroke) so they read as native without being the system font. Icons use
  `currentColor` so they inherit the text-colour tokens. Keep one source set; do
  not mix icon libraries (no drifting stroke weights or corner styles).
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
  mirroring the sidebar: collapsing animates `transform: translateX` off the
  right window edge plus `opacity`, over `--motion-layout`. Only transform and
  opacity animate, so the rail moves as one GPU-composited layer and its
  transcript + composer ride along rigidly — they never re-wrap mid-animation.
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

## Components

Components are thin contracts. They should define structure, state, semantics,
and non-goals; product behavior stays with the owning surface.

| Component | Sources | Contract |
| --- | --- | --- |
| `CheckboxMark` | `CheckboxMark.tsx` | Decorative `16px` checkbox mark with `3px` radius. Unchecked is outlined; checked is success-filled with a fixed-white check glyph (`--text-on-accent`, theme-independent). Does not own row behavior or persistence. |
| `CheckboxControl` | `CheckboxControl.tsx`, `AgentSettingsDialog.tsx` | Labeled native checkbox wrapper for settings/forms. Keeps native checkbox semantics and `CheckboxMark` visual together. |
| `SwitchControl` / `SwitchMark` | `SwitchControl.tsx`, `SwitchMark.tsx`, `DefinitionConfigControls.tsx`, `TypedFieldValueControl.tsx` | Semantic switch wrapper plus shared `30px x 18px` track and `14px` thumb. Does not own labels or persistence. |
| `IconButton` | `IconButton.tsx` | Icon-first button with explicit accessible label and tokenized icon size. Visual variant stays caller-owned. |
| `MenuSurface` | `MenuSurface.tsx`, `PopoverList.tsx`, `NodeContextMenu.tsx` | Shared menu/popover wrapper. Caller owns role, positioning, keyboard navigation, filtering, and execution. Edge separation comes from pure overlay shadow, not border. |
| `MenuItem` | `MenuItem.tsx`, command/menu rows | Stable row contract for icon, label, metadata, active, disabled, selected, and danger states. |
| `AnchoredOverlay` | `AnchoredOverlay.tsx` | Viewport-aware anchored positioning and outside dismissal wiring. Does not own menu contents or commands. |
| `PopoverListbox` | `PopoverList.tsx`, trigger/option/tag/reference/slash popovers | Listbox shell and option item structure. Active index and filtering remain caller-owned. |
| `Dialog` | `Dialog.tsx`, `AgentSettingsDialog.tsx`, `CommandPalette.tsx` | Modal shell with label linkage, Escape handling, focus trap, initial focus, and focus restoration. |
| `ButtonControl` | `ButtonControl.tsx` | Native button wrapper with default `type="button"` and ref forwarding. Visual variants stay class-owned. |
| `SelectControl` | `SelectControl.tsx` | Native select wrapper. Options and value coercion stay caller-owned. |
| `TextInputControl` | `TextInputControl.tsx` | Native input wrapper. Draft, validation, and commit behavior stay caller-owned. |
| `NumberInputControl` | `NumberInputControl.tsx` | Native number input wrapper. Parsing and empty-value semantics stay caller-owned. |
| `PanelSurface` | `WorkspacePanelSurface.tsx` | Opaque content pane (`--bg-content`), flush within the content base — no card radius, no gap. Panes are divided by a 1px `--separator` (the resize handle), not a per-pane border. Active pane indication is a subtle neutral control-state cue, never a box outline. |
| `ResizeHandle` | `ResizeHandle.tsx` | Shared resize button structure. Pointer behavior stays in `useResizableLayout`. |
| `AppliedTag` | `AppliedTag.tsx` | Fixed measured tag pill using tag palette background/text colors. Hover/focus must not shift row width. |

## Interaction States

Every interactive component shares one canonical state model mapped to tokens.
Per-component contracts only note deviations from this table.

| State | Treatment |
| --- | --- |
| Rest | Transparent, or `--fill-2` for a resting control. Text `--text-primary` / `--text-secondary`. |
| Hover | Region/row controls: `--fill-1` (subtle) or `--fill-2`. Icon-only controls: deepen the glyph colour (`--text-secondary` → `--text-primary`), no fill. Layout must not shift; cursor stays default on rows. |
| Pressed / active | `--fill-4`. |
| Selected | `--selection-bg` (`--fill-3`); multi-select / range uses `--selection-soft` (`--fill-2`). |
| Focus (keyboard) | `--outline-focus` + `--focus-ring-shadow`. Always visible, neutral — never brand or system accent. Text controls (`input` / `textarea` / `select`) carry the same neutral ring as buttons: the outer `--focus-ring-shadow` by default, or — for a borderless input inside a clipped inset card — the inset `--outline-focus` on the **row** (`:focus-within`), since an outer ring would be cropped by the card's `overflow:hidden`. |
| Disabled | `--text-disabled` / `--text-quaternary`; no hover; reduced-intensity fill. |
| Loading | Reserve one measured slot so the label and size do not jump; spinner uses `--text-secondary`. |
| Error / destructive | `--status-danger` text/outline marks the resting destructive affordance. Its **hover stays neutral** (`--control-hover`), not a status tint — functional state is neutral (B3); the status colour rides on the label, not the hover fill. |

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
- **No pointer cursor on hoverable rows.** Native lists do not switch the cursor;
  a pointer cursor reads as web. Text cursor only on real text.
- **One disclosure/status slot.** Labels must not move across rest, hover, focus,
  loading, and expansion (generalizes the agent disclosure rule).

## Surfaces

### Shell

The shell is a full-bleed opaque content base with two floating glass rails (the
sidebar on the left, the agent dock on the right) and a single top strip that
holds every column's header. There is **no global tab strip** — the sidebar is
the switcher.

**Layering.** The content base fills the window edge to edge. The sidebar and
agent rails float above it (rounded, slightly inset, soft elevation, vibrancy
showing the content blurred beneath). See Materials & Liquid Glass.

**Full-height sidebar.** The sidebar runs top to bottom on the left as a floating
glass rail. The macOS traffic lights sit at its top; the sidebar toggle sits
beside them. Default width `216px`; range `180px` to `280px`. Sidebar rows use one
quiet navigation grammar: `28px` row height, `6px` radius, `16px` icon slots.
Primary entries use `--control-hover` on hover; the workspace tree darkens text
rather than holding a persistent selected fill. The sidebar is the navigator
(Today / Search / Supertags / Library / Recents + the workspace tree + Settings).

**Top strip (the drag region).** One horizontal strip at the window top, at
traffic-light height, holds **every column's header in a single row**:
- Far left: traffic lights + the sidebar toggle (in the sidebar rail's top).
- Middle: each outliner pane's own breadcrumb header (`avatar / path / current`)
  with a `×` close at its right. The last remaining pane shows no `×`.
- Far right: the agent dock's header (its `✦` brand mark + conversation title)
  when open, and — pinned to the absolute top-right corner — the agent toggle.

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
width `330px`; range `300px` to `520px`. Its header (`✦` + conversation title)
lives in the top strip; the `✦` brand mark is one of the sparse rose-accent
roles.

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
  `--font-ui-sm` / `--font-ui-xs` text. The filename is primary, metadata is
  secondary, and long names truncate within the content column rather than
  resizing the row. A PDF thumbnail may replace the file-kind glyph; otherwise
  file type uses the shared monochrome `inlineFileIcon` mask mechanism painted
  with `currentColor`. System action buttons are icon-only, remain hidden until
  hover/focus, and deepen icon color without drawing a hover box.
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
  first-supertag text color when available, otherwise the brand `--link` (rose).
  They must NOT introduce a second link colour (e.g. `--status-info` blue) — the
  app has exactly one link colour. Reference nodes remain block rows with the
  neutral dashed reference marker.
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
  itself keeps the normal text-link hover treatment; the popover is the only added
  surface and uses the elevated popover material + level-1 shadow with
  reduced-transparency fallback.
- Clicking a local-file inline ref opens the file or folder through the preload
  bridge and main-process `shell.openPath` only after the main process
  canonicalizes the path under the non-root agent local file root, stats it as a
  regular file/folder, and rejects executable or bundle-like open targets.
  Renderer code must not navigate to `file://`, call `openExternal` for file
  paths, or read local bytes directly. Composer local-file atoms expose the same
  preview metadata, but click handling stays with the editor so draft text
  remains selectable and editable.

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
  restraint); its hover feedback is a centred fill tint on the icon itself, not a
  glass chip behind it. The toggle is the collapse control in both states.
- Its header lives in the top strip: the plain conversation title, no decorative
  status dot or `#` prefix. A DM leads with that agent's circular identity chip
  and a quiet subtitle (`@mention · provider/model`), with an action to create a
  Channel from the DM. A Channel uses the Channel name as the primary text and
  moves member management behind a compact Members popover; stacked avatars are
  a secondary cue, not the title. The title trigger has no hover background; it
  darkens text and reveals its chevron only on hover, focus, or open state. The
  agent header carries no `✦` toggle of its own — collapsing happens through the
  fixed top-right control.
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
  live roster alone.
- Message metadata is quiet by default. Time separators appear only at meaningful
  transcript gaps; right-click opens the native message menu, whose Details action
  shows timestamp, speaker, model, and token usage in a small anchored popover.
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
  divider. Its footer controls (attach / model / send) are capsules (B6).
- The model chip is display + navigation, not an inline picker. It shows the
  active provider/model and reasoning label, and clicking opens the owning
  settings surface (agent profile for authored agents, provider config for the
  built-in assistant/global provider). It never mutates provider/model settings
  from the chat surface.
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
  under it — see `main.tsx`, which sets `data-window-material` for the main surface
  only), so the rail floats on an opaque `--bg-elevated`, not a translucent
  material. Rail rows keep the
  category IA, but add a compact neutral icon slot and a single clear label per
  row so scanning is closer to System Settings without explanatory subcopy or
  functional status color. The content pane is the flat window base (no
  surrounding card) and is the single scroll container, so the rail stays put; the
  grouped cards float on it on an opaque `--bg-elevated` surface. The content
  column is constrained
  (`--settings-content-max-width`) so rows keep a stable reading width instead of
  stretching across the whole window. There is NO permanent side detail pane:
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
  Providers list no leading status column — "Connected" vs "Available" already
  carries connection state, so a per-row marker would be redundant. Rows show a
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
  from the radius / hairline ladders (B9). The card is its own region by COLOUR —
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
    decision width, so non-allowable rows do not collapse to a different-looking
    control; the row sublabel stays human-readable and does not expose raw rule strings),
    Agent Profiles' selectable profile list — all are `InsetRow`s. Agent Profiles
    is hierarchical: the category page shows the profile list only, and rows are
    pure drill-down rows with a trailing chevron. Do NOT combine a switch and a
    drill-down chevron in the same row. Clicking a profile row pushes an
    `agent-detail` route onto the Settings history stack. The detail route uses the
    same toolbar back/forward capsule, shows the enable/disable switch as its own
    settings row, and shows the persona card as the next level, not as flat content
    below or beside the list.
  - **One secondary button.** Filled neutral `--fill-2`, no border
    (`.agent-settings-secondary` / `.settings-sheet-secondary`) — the native push
    button, pairing with the filled-strong primary; never a ghost outline.
  - **One chip.** `.settings-chip` — `--radius-xs`, `--control-hover`, sentence case
    (no uppercase) — for quiet metadata such as skill source, ignored-rule
    diagnostics, and agent tool tags. Do not duplicate a trailing control's current
    value with an inline chip.
  - **One empty / loading state.** Plain muted text (`.agent-settings-empty`), no
    dashed box (native, not a web drop-zone); a `.is-centered` variant fills a
    detail pane.
  - **One notice / banner.** Neutral `--fill-1` box with the status colour on TEXT
    only (`.agent-settings-alert` / `.settings-sheet-result`), never a status-tinted
    fill (B4).
- **Provider rows.** Providers group into "Connected" (has a credential — key,
  env, or managed) and "Available". Each row is the brand avatar as identity + the
  name; clicking it opens the config sheet. Every provider mark — vendored brand
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
- **Per-provider config — its OWN native window, connection + global model.** Clicking a row
  (or "Configure…") opens the config as a real native window, NOT an in-renderer
  overlay: a frameless **modal child of the settings window** (`?surface=provider-config`,
  opened by the main process via `lin:open-provider-config`) — the macOS System
  Settings idiom where a list row opens a real attached dialog (cf. the Wi-Fi
  password sheet). The window IS the dialog surface (`.provider-config-window`,
  `ProviderConfigWindow.tsx` → `ProviderConfigForm.tsx`): opaque, filling the frame,
  no traffic lights (closed by its own Cancel / Save or Escape), no backdrop (the OS
  dims the parent). It has a brand-avatar + title/subtitle head and a SINGLE inset
  card holding the connection plus the built-in assistant's global model/reasoning:
  a label-less credential row (a key glyph + the field, native password-dialog
  style), catalog model select, thinking-level select, and the base URL inline
  (the lone advanced setting — no disclosure). Custom (OpenAI-compatible)
  providers additionally enter a provider id and a model id in the same card,
  since there is no catalog to default from. It fetches its own
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
  idiom on `--surface-inverse` (shared with `.agent-settings-primary` and the
  composer send button), never a system-blue accent (B4). The earlier `--fill-3`
  tint read weaker than the bordered secondary; the solid fill makes the main action
  unmistakable. Secondary is the bordered surface button; danger (`--status-danger`
  text) is reserved for genuinely destructive actions (Sign out / Remove provider),
  so exactly one button per footer reads as primary.

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

Dragging (outliner row reorder/indent, multi-select drag) stays neutral and
quiet, like the rest of functional state:

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

## Content & States

- **Voice & tone:** concise, calm, factual. No marketing exclamation. Action
  labels are verbs (`New page`, not `Create a brand-new page!`). Error messages
  say what happened and what to do — no blame, no stack traces in product UI.
- **Empty states:** a single quiet hint at the point of action (the outliner idle
  hint `Type here or '/' for commands`), not an illustrated empty-state card. The
  empty agent panel follows the same rule: when a provider is usable it shows one
  muted greeting line; when provider settings have **loaded** and none is usable it
  shows a quiet onboarding line + a neutral CTA that opens Settings › Providers, and
  the composer send is disabled (neutral, with a tooltip) — gated on the loaded
  state so a key-holding user never sees the onboarding flash during the async load.
- **Loading:** prefer an in-place reserved slot or skeleton over a spinner that
  shifts layout. The first frame is the working surface, not a splash.
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

## Implementation Rules

1. Product behavior remains authoritative.
2. Update this file before or with UI changes that alter system contracts.
3. Use tokens before adding one-off values.
4. Add abstractions only when they remove real duplication or clarify ownership.
5. Keep component primitives thin. They should not absorb product behavior by
   accident.
6. Do not style fake preview panels as if they were shipped UI.
7. Keep reference snippets tokenized and source-backed. They may simplify
   examples but should not invent a second visual language.
8. When changing frontend behavior or visuals, run focused e2e coverage and
   update screenshots or specimens when useful.

## Versioning & Maintenance

- **Tokens are the dev variables.** Two tiers: **foundation tokens** (the ones in
  Foundations — color, type, spacing, radius, elevation, motion) are the CSS
  custom properties in `styles.css`, 1:1, and are documented here; **component-
  private tokens** (e.g. `--panel-content-*`, `--inline-ref-*`) may live in
  component CSS without a foundation entry, as long as they derive from foundation
  tokens. Add or rename a foundation token here in the same change
  that touches the CSS. A live-token audit (which existing tokens are foundation,
  component-private, or slated for deletion — e.g. `--tab-*` from the old tab
  model) is tracked in the rollout plan, not inventoried here.
- **Naming:** tokens are semantic-role names (`--text-primary`, `--fill-3`,
  `--material-sidebar`), never raw-value names (`--gray-200`). Component contracts
  use the component name matching the source file.
- **Migration:** legacy aliases bridge old names onto the semantic layer; remove
  an alias once all usages migrate. Pre-launch, so no compatibility burden —
  cut over directly rather than keeping shims.
- **Change discipline:** this file is updated before or with any UI change that
  alters a system contract (Implementation Rule 2). The main agent records
  notable system changes in `CHANGELOG.md` on merge.

## Validation

Expected checks for design-system changes:

- `bun run typecheck`
- Focused Playwright tests for touched surfaces.
- `tests/e2e/typography-tokens.spec.ts` for token discipline.
- `git diff --check`

Use screenshot review for shell, panel, outliner, overlay, and agent changes
when visual judgment is central to the request.
