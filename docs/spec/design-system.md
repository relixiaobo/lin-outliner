# Tenon Design System

This file is the kernel and index for Tenon's product UI system. It owns the
current intended design language at the decision level: product intent, principles,
rule routing, exceptions, and validation. Detailed contracts live in the layered
files under [`docs/spec/design-system/`](./design-system/).

Historical rollout work lives in
[docs/plans/archive/design-system-rollout.md](../plans/archive/design-system-rollout.md);
future gaps belong in `docs/plans/` and on `docs/TASKS.md`, not in this spec.
Product code and this contract must stay in sync.

## Product Intent

Tenon should feel like a dense desktop knowledge workspace:

- Quiet neutral chrome.
- Persistent sidebar.
- Persistent agent dock.
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
   buttons) is neutral. Rose is a rare signal — caret, brand marks, small status
   badges — never the everyday active state, and never the system accent. Links
   are the one coloured affordance: they use a fixed native link blue (macOS
   `linkColor`), so clickable text reads as a link, never as an error.
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

## Reference Model

Tenon's design-system contract follows the structure shared by strong product
systems: foundations define tokens and primitives, components define reusable UI
contracts, patterns define interaction behavior, surfaces apply the system to
product areas, and validation keeps implementation honest. The reference model is
informed by official systems such as [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/),
[Material Design](https://m3.material.io/), [IBM Carbon](https://carbondesignsystem.com/),
[Microsoft Fluent 2](https://fluent2.microsoft.design/), [Atlassian Design System](https://atlassian.design/),
[Shopify Polaris](https://polaris.shopify.com/), and the [GOV.UK Design System](https://design-system.service.gov.uk/).

Use those systems for structure and governance, not for Tenon's visual skin.
Tenon's product language remains dense, neutral, native-feeling, and content-led.

## Clean Interface Test

A Tenon UI is clean, clear, simple, and elegant only when all of these are true:

1. The product object is visible first; chrome explains less than the content does.
2. One surface has one dominant hierarchy: object, local metadata, then actions.
3. Interactive feedback is the smallest sufficient signal: neutral fill, colour
   deepening, focus ring, or stable disclosure slot.
4. The layout is stable across hover, focus, loading, expansion, and drag.
5. Actions sit near the thing they affect and use native control idioms before
   custom styling.
6. Colour carries semantic meaning only: neutral for functional state, blue for
   links, rose for sparse brand accent, status colours for status.
7. Density comes from alignment, measured slots, and shared rhythm, not cramped
   text or hidden affordances.
8. Empty, loading, and error states occupy the action point; they do not become
   decorative marketing panels.
9. Every exception is named, scoped, and tested or visually verifiable.

## Layer Map

| Layer | Owns | Does Not Own | File |
| --- | --- | --- | --- |
| Kernel | Intent, principles, decision routing, source map, exceptions, validation summary. | Detailed component or surface rules. | This file |
| Foundations | Tokens, colour, material, typography, spacing, radius, elevation, icons, motion. | Product-specific UI decisions. | [foundations.md](./design-system/foundations.md) |
| Components | Shared primitives and their state/semantics/non-goals. | Product behavior or layout ownership. | [components.md](./design-system/components.md) |
| Patterns | Cross-component interaction states, content states, accessibility, native-feel boundary. | Surface-specific geometry. | [patterns.md](./design-system/patterns.md) |
| Surfaces | Shell, workspace, outliner, references, fields, menus, agent, settings. | Foundation token definitions. | [surfaces.md](./design-system/surfaces.md) |
| Implementation | Change discipline, token maintenance, checks, and visual verification expectations. | Product planning status. | [implementation.md](./design-system/implementation.md) |
| Decision Audit | The sampled proof that UI decisions derive from the core system. | New rules or product behavior. | [decision-audit.md](./design-system/decision-audit.md) |
| Calibration Audit | Current finding classification: code drift, spec drift, named exceptions, and open design decisions. | New rules or product behavior. | [calibration-audit.md](./design-system/calibration-audit.md) |

## Decision Path

When changing UI, use this order:

1. Identify the product surface in [surfaces.md](./design-system/surfaces.md).
2. If the change is reusable, check [components.md](./design-system/components.md)
   before adding local styling.
3. If the change is a state, overlay, drag/drop, empty/loading/error, keyboard, or
   accessibility behavior, check [patterns.md](./design-system/patterns.md).
4. If the change needs a value, derive it from [foundations.md](./design-system/foundations.md)
   and `src/renderer/styles/tokens.css` before adding a new token.
5. If the rule is new or an exception, record it in the smallest owning layer and
   add or update validation in [implementation.md](./design-system/implementation.md).

If two files appear to own the same decision, that is a spec bug. Keep the rule in
one owner and link to it from the other file.

## Source Map

| Area | Product Sources | Contract |
| --- | --- | --- |
| Shell and rails | `App.tsx`, `WindowChrome.tsx`, `Sidebar.tsx`, `AgentDock.tsx`, `useWorkspaceLayout.ts` | [Surfaces → Shell](./design-system/surfaces.md#shell) owns window chrome, floating rails, shell layout, and collapse controls. |
| Workspace canvas | `WorkspaceCanvas.tsx`, `WorkspacePanelSurface.tsx`, `ResizeHandle.tsx`, `useResizableLayout.ts` | [Surfaces → Workspace And Panels](./design-system/surfaces.md#workspace-and-panels) owns tiled panels, resize slots, ratio fill, and local overflow. |
| Outliner panel | `NodePanel.tsx`, `OutlinerView.tsx`, `OutlinerItem.tsx`, `styles/outliner.css` | [Surfaces → Outliner](./design-system/surfaces.md#outliner) owns title, breadcrumb, tags, rows, fields, references, and triggers. |
| Outliner rows | `OutlinerRowShell.tsx`, `RowLeading.tsx`, `RowMarker.tsx`, `RowHost.tsx`, `useOutlinerRowInteraction.ts` | [Surfaces → Outliner](./design-system/surfaces.md#outliner) owns row geometry, selection, leading markers, and chevron behavior. |
| Fields and definitions | `DefinitionConfigPanel.tsx`, `DefinitionConfigControls.tsx`, `DefinitionConfigRowShell.tsx`, `FieldEntryGrid.tsx`, `OutlinerFieldRow.tsx`, `FieldValueOutliner.tsx` | [Surfaces → Fields And Definition Configuration](./design-system/surfaces.md#fields-and-definition-configuration) owns field rows, field values, and definition configuration. |
| Tags | `AppliedTag.tsx`, `TagBar.tsx`, `tagColors.ts`, `TagSelector.tsx`, `BatchTagSelector.tsx` | [Patterns → Tag Hover](./design-system/patterns.md#tag-hover) owns tag hover/action behavior; [Surfaces → Outliner](./design-system/surfaces.md#outliner) owns tag placement. |
| Editor and commands | `RichTextEditor.tsx`, `CodeBlockSurface.tsx`, `FloatingEditorToolbar.tsx`, `CommandPalette.tsx`, `nodeLineTrigger.ts` | [Components → Overlays](./design-system/components.md#overlays) owns overlay semantics; [Surfaces → Menus, Popovers, And Dialogs](./design-system/surfaces.md#menus-popovers-and-dialogs) owns command/menu surfaces. |
| Menus and overlays | `MenuSurface.tsx`, `MenuItem.tsx`, `useAnchoredOverlay.ts`, `AnchoredActionMenu.tsx`, `Dialog.tsx`, `PopoverList.tsx`, `NodeContextMenu.tsx`, `TriggerPopover.tsx`, `ReferenceSelector.tsx`, `SlashCommandMenu.tsx` | [Surfaces → Menus, Popovers, And Dialogs](./design-system/surfaces.md#menus-popovers-and-dialogs) owns positioning, elevation, dismissal, keyboard wiring, and item rows. |
| Agent dock | `AgentDock.tsx`, `AgentChatPanel.tsx`, `AgentDebugPanel.tsx` | [Surfaces → Agent](./design-system/surfaces.md#agent) owns the persistent dock, chat scroll, debug surface, and settings entry. |
| Agent messages | `AgentMessageRow.tsx`, `AgentMessageFrame.tsx`, `AgentIdentityAvatar.tsx`, `AgentBranchNavigator.tsx`, `AgentProcessBlock.tsx`, `AgentProcessTimeline.tsx`, `AgentThinkingBlock.tsx`, `AgentToolCallBlock.tsx`, `AgentToolCallDisclosure.tsx` | [Components → Activity And Disclosure Rows](./design-system/components.md#activity-and-disclosure-rows) owns process rows; [Surfaces → Agent](./design-system/surfaces.md#agent) owns message surfaces and status slots. |
| Agent composer | `AgentComposer.tsx`, `AgentComposerControls.tsx`, `AgentComposerModelControl.tsx` | [Patterns → Agent Conversation Flow](./design-system/patterns.md#agent-conversation-flow) owns composer flow; [Surfaces → Agent](./design-system/surfaces.md#agent) owns attachments, send/stop slot, and model chip placement. |
| File previews and inline files | `FilePreviewBody.tsx`, `FilePreviewPanel.tsx`, `FilePreviewPill.tsx`, `FileNodeActionMenu.tsx`, `InlineFileReference.tsx`, `InlineFilePreviewLayer.tsx`, `inlineFileIcon.ts` | [Components → File Preview Frame And HUD](./design-system/components.md#file-preview-frame-and-hud) owns preview chrome; [Patterns → File Preview Flow](./design-system/patterns.md#file-preview-flow) owns inline preview behavior. |
| Agent settings | `AgentSettingsView.tsx`, `SettingsInsetList.tsx`, `SettingsRowMenu.tsx`, `ProviderConfigWindow.tsx` / `ProviderConfigForm.tsx`, `AgentConfigWindow.tsx`, `ChannelConfigWindow.tsx`, `providerCatalog.tsx`, `styles/settings-*.css` | [Surfaces → Settings Window](./design-system/surfaces.md#settings-window) owns the standalone settings window, inset grouped content, row menu, and child config windows. |
| Primitives | `Button.tsx`, `ButtonControl.tsx`, `CheckboxControl.tsx`, `CheckboxMark.tsx`, `IconButton.tsx`, `SwitchControl.tsx`, `SwitchMark.tsx`, `SegmentedControl.tsx`, `Input.tsx`, `Textarea.tsx`, `Field.tsx`, `SelectControl.tsx`, `FeedbackState.tsx` | [Components → High-Leverage Contracts](./design-system/components.md#high-leverage-contracts) owns shared primitive contracts and native control semantics. |

## Load-Bearing Rules

These rules are the quick contract agents should hold in memory. The layered files
carry the detailed form.

1. **Two themes over one ink base.** Every value is a token; colour is alpha-on-ink
   (`--ink` + text/fill/separator ladders). Dark mode flips `--ink`.
2. **Dark mode is OS-driven.** Use `@media (prefers-color-scheme)` and
   `color-scheme: light dark`; the app override drives `nativeTheme.themeSource`.
3. **Functional state is neutral.** Selection, hover, active, focus, and ordinary
   controls use the neutral ladder, never brand or status colour.
4. **One rose accent, one native-blue link.** Rose is sparse brand activity; links
   use `--link` and never status or accent colour.
5. **Two-layer material model.** Content is opaque; only chrome and overlays carry
   material. Every material has reduced-transparency and contrast fallbacks.
6. **Icon controls deepen colour first.** Icon-only chrome controls do not gain a
   rounded-square hover box.
7. **Hover never changes layout.** No scale pop, height jump, text reflow, or
   neighbor movement.
8. **Accessibility preferences are part of the system.** Focus-visible,
   contrast, reduced motion, and reduced transparency are mandatory behavior.
9. **Use the radius/spacing/type/shadow ladders.** Derive nested geometry from the
   concentric chain instead of picking values by eye.
10. **Native feel beats web habits.** No pointer cursor on non-links; chrome text
    is not user-selectable; overlays use native dismissal and focus behavior.
11. **Guards enforce the contract.** Fix CSS/spec drift; do not relax design-system
    guards just to pass.

## Exception Registry

| Exception | Scope | Authority | Evidence |
| --- | --- | --- | --- |
| External document pixels may force a light canvas. | HTML/EPUB/PDF document content inside file previews only; preview chrome stays tokenized. | [surfaces.md → Outliner](./design-system/surfaces.md#outliner) | `tests/e2e/typography-tokens.spec.ts` token guards + focused file-preview visual checks when the preview surface changes. |
| Scoped dark-media rules are allowed for generated colour streams. | Shiki or equivalent third-party/generated colour variables, with local comments and no renderer theme bridge. | [foundations.md → Color & Appearance](./design-system/foundations.md#color--appearance) | `tests/e2e/typography-tokens.spec.ts` raw-hex/token guards and local comments on every scoped rule. |
| Global launcher uses vibrant system glass. | The separate system launcher window only; in-app command palettes remain opaque elevated surfaces. | [foundations.md → Materials & Liquid Glass](./design-system/foundations.md#materials--liquid-glass) | `docs/spec/launcher.md` + launcher visual verification for transparency/reduced-transparency changes. |
| Preview HUD controls own contrast tokens. | Bottom-center file preview action controls over arbitrary document/image pixels. | [foundations.md → Foundations](./design-system/foundations.md#foundations) | `--preview-action-*` token presence in `src/renderer/styles/tokens.css` + focused file-preview visual checks over white document pixels. |
| Composer model/effort chip is a profile shortcut. | Agent composer footer only; it edits the standing agent profile, not provider state or per-conversation identity. | [surfaces.md → Agent](./design-system/surfaces.md#agent) | `tests/e2e/agent-composer.spec.ts` → "the composer footer shows the profile model shortcut". |
| Icon masks and provider logos are identity assets. | Inline-file masks and provider marks; they are not a second product icon library. | [foundations.md → Icons](./design-system/foundations.md#icons) | `tests/e2e/typography-tokens.spec.ts` token guards + icon-semantics review when icon assets change. |
| `cursor: help` is allowed for diagnostics. | Inline diagnostic hints or native-title tooltips only. | [patterns.md → Interaction States](./design-system/patterns.md#interaction-states) | `tests/e2e/cursor-affordances.spec.ts` for cursor policy. |
| Document outline mini-rail hides its scrollbar. | EPUB/document outline mini-rail track only; content scroll containers keep native lightweight scrollbars. | [foundations.md → Foundations](./design-system/foundations.md#foundations) | `tests/e2e/typography-tokens.spec.ts` hidden-scrollbar guard + `tests/e2e/design-system-runtime.spec.ts` document outline rail surface. |
| Native window rounding depends on compiled addon output. | macOS 24px app window corner; each clone must run `bun run build:native` before visual verification. | [foundations.md → Token Rules](./design-system/foundations.md#token-rules) | `tests/e2e/window-material.spec.ts` plus packaged/native-corner visual verification when window geometry changes. |
| Model-upload JPEG alpha matting may force a white canvas. | Agent composer image resizing only; it composites transparent pixels against white before JPEG encoding for model upload and never paints app chrome. | [surfaces.md → Agent](./design-system/surfaces.md#agent) | `scripts/design-system-metrics.ts` named raw-hex exception + `src/renderer/ui/agent/AgentComposer.tsx` image upload path. |

## Foundations

Canonical rules live in [foundations.md](./design-system/foundations.md). This
heading is retained as a stable anchor for older links.

## Components

Canonical rules live in [components.md](./design-system/components.md).

## Interaction States

Canonical rules live in [patterns.md → Interaction States](./design-system/patterns.md#interaction-states).

## Surfaces

Canonical rules live in [surfaces.md](./design-system/surfaces.md).

## Patterns

Canonical rules live in [patterns.md](./design-system/patterns.md).

## Content & States

Canonical rules live in [patterns.md → Content & States](./design-system/patterns.md#content--states).

## Accessibility

Canonical rules live in [patterns.md → Accessibility](./design-system/patterns.md#accessibility).

## Cross-Platform Native Feel

Canonical rules live in [patterns.md → Cross-Platform Native Feel](./design-system/patterns.md#cross-platform-native-feel).

## Implementation Rules

Canonical rules live in [implementation.md → Implementation Rules](./design-system/implementation.md#implementation-rules).

## Versioning & Maintenance

Canonical rules live in [implementation.md → Versioning & Maintenance](./design-system/implementation.md#versioning--maintenance).

## Validation

Canonical rules live in [implementation.md → Validation](./design-system/implementation.md#validation).
At minimum, design-system changes run `bun run docs:check`, `bun run typecheck`,
focused Playwright coverage for touched surfaces, the relevant design-system guard
specs, `bun scripts/design-system-metrics.ts --check`, and `git diff --check`.
