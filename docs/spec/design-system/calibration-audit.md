# Tenon Design System Calibration Audit

This file records the current renderer UI design-system calibration ledger. It is
not a new rule layer. Rules still live in the kernel, foundations, components,
patterns, surfaces, and implementation files; this audit classifies findings and
points to the evidence that proves each decision.

## Classification Model

| Class | Meaning | Required response |
| --- | --- | --- |
| Code drift | Product code or a guard violates the design-system contract. | Fix code or guard behavior, then add evidence. |
| Spec drift | The spec contradicts current intended product behavior or another owning rule. | Fix the smallest owning spec layer; do not change UI just to satisfy stale prose. |
| Named exception | A local exception is intentional, scoped, and evidenced. | Keep it named in the registry or metrics exception table; fail stale exceptions. |
| Open design decision | The right rule is directional, taste-bearing, hard to reverse, or product-changing. | Do not guess. Record the decision point and escalate before implementation. |

## Calibration Rule

When code and spec disagree, the answer is not automatically "make code obey the
current spec." First decide the owner:

1. If the product behavior is correct and the prose is stale, fix the spec.
2. If the spec expresses a reusable rule and code diverges locally, fix the code.
3. If the behavior is valid but local, name it as an exception with evidence.
4. If the choice changes product behavior or taste, treat it as an open design
   decision and stop before implementation.

Any standard adjustment must improve reuse, consistency, or measurability. A
standard change that only hides one local violation is not accepted.

## Findings Ledger

| ID | Finding | Class | Resolution | Evidence |
| --- | --- | --- | --- | --- |
| CA01 | Component coverage counted JSX-like text in comments and missed several documented primitives. | Code drift | Metrics now use the TypeScript AST and map documented component contracts to real JSX/export names. | `scripts/design-system-metrics.ts`; `bun scripts/design-system-metrics.ts --check` |
| CA02 | Raw-hex enforcement only scanned CSS while renderer TS/TSX could still carry source literals. | Code drift | Raw-hex scan now covers renderer CSS, TS, and TSX with a named source-literal exception path. | `scripts/design-system-metrics.ts`; raw hex outside tokens = 0 |
| CA03 | Product-surface native controls were not separated from primitive implementation internals. | Code drift | Metrics distinguish product direct native use, named native-control exceptions, and primitive implementation internals. | `scripts/design-system-metrics.ts --json` |
| CA04 | Native-control exceptions were counted but not reported by file/reason, and stale entries could survive. | Code drift | Metrics now report `exceptedNativeFiles` with counts/reasons and fail stale exception entries. | `scripts/design-system-metrics.ts --json`; `staleNativeControlExceptions: []` |
| CA05 | Provider-ready empty agent conversations had conflicting rules: greeting text in one spec path, blank current product behavior elsewhere. | Spec drift | The spec now follows current product/test behavior: provider-ready empty conversations stay visually blank; no-provider onboarding remains explicit. | `patterns.md`, `surfaces.md`, `tests/e2e/agent-onboarding.spec.ts` |
| CA06 | Destructive interaction guidance overgeneralized neutral hover and conflicted with solid destructive confirmation buttons. | Spec drift | Interaction states now distinguish ordinary destructive affordance hover from solid destructive confirmation buttons. | `patterns.md`, `components.md`, `foundations.md` |
| CA07 | Tag color code still allowed raw/alias palette paths while the design system wanted tokenized, theme-aware tags. | Code drift | Tag storage now uses a closed token palette; invalid raw/alias values are rejected/fall back. | `src/core/configSchema.ts`, `src/renderer/ui/tags/tagColors.ts` |
| CA08 | Tag color docs did not clearly describe the closed token palette and invalid raw/alias fallback behavior. | Spec drift | Foundations now describe the closed tag palette and fallback behavior. | `foundations.md` |
| CA09 | Focus/radius token gaps left valid CSS values looking like one-off literals. | Code drift | Added/used shared tokens for `--focus-ring-shadow-inset` and `--radius-none`. | `src/renderer/styles/tokens.css`; `tests/e2e/typography-tokens.spec.ts` |
| CA10 | Pointer cursor policy needed tighter enforcement for non-link inline reference render paths. | Code drift | Non-link agent inline references are gated away from pointer affordance; cursor guard covers pointer declarations and representative controls. | `tests/e2e/cursor-affordances.spec.ts` |
| CA11 | Representative runtime surface coverage did not include enough complex overlays, settings panes, previews, and agent detail surfaces. | Code drift | Runtime guard now covers shell, onboarding, settings panes, config child windows, overlays, date picker, file/image previews, agent process details, and run details in light/dark. | `tests/e2e/design-system-runtime.spec.ts` |
| CA12 | Material surfaces relied on convention that every `backdrop-filter` uses the shared material token. | Code drift | Token guard now fails any local backdrop filter outside `var(--material-backdrop)` or explicit `none`. | `tests/e2e/typography-tokens.spec.ts` |
| CA13 | Some comments still described historical rollout phases instead of the current shared-token system. | Spec drift | Comments now describe current shared material fallback and current SettingsInsetList reuse. | `src/renderer/styles/a11y.css`, `agent-dock.css`, `outliner.css`, `popover-command.css`, `shell.css`, `SettingsInsetList.tsx` |
| CA14 | Outliner trigger popovers and code-block chrome were high-interaction surfaces but not represented in the shared runtime guard. | Code drift | Runtime guard now opens tag suggestions, slash commands, reference suggestions, and the code-block language menu in light/dark without changing outliner layout behavior. | `tests/e2e/design-system-runtime.spec.ts` |
| CA15 | Shared menu and floating-tool chrome was implemented through primitives but not opened by the runtime design-system guard. | Code drift | Runtime guard now opens row/sidebar context menus, batch tag selector, floating text toolbar, file-preview pill menu, and image-row action menu in light/dark. | `tests/e2e/design-system-runtime.spec.ts` |
| CA16 | Agent composer interaction chrome had static coverage but not runtime coverage for its menus and suggestion surfaces. | Code drift | Runtime guard now opens the channel picker, channel options menu, mention suggestions, model menu, and reasoning flyout in light/dark. | `tests/e2e/design-system-runtime.spec.ts` |
| CA17 | View configuration and schema definition surfaces were covered by focused behavior specs but absent from the shared runtime design-system guard. | Code drift | Runtime guard now opens view-toolbar sort/filter popovers, the definition config panel, and the definition picker in light/dark. | `tests/e2e/design-system-runtime.spec.ts` |
| CA18 | Document preview outline navigation had focused behavior coverage but no shared runtime design-system coverage. | Code drift | Runtime guard now opens an EPUB full preview and its document outline rail/popover in light/dark. | `tests/e2e/design-system-runtime.spec.ts` |
| CA19 | Shared confirm, inline-file menu, and composer error surfaces were implemented through product paths but absent from the shared runtime design-system guard. | Code drift | Runtime guard now opens the destructive confirm dialog, inline-file context menu, and composer attachment error status in light/dark through real UI entry points. | `tests/e2e/design-system-runtime.spec.ts` |
| CA20 | Tag badge context actions hand-rolled menu DOM instead of the shared menu primitive and had no runtime design-system coverage. | Code drift | Tag badge actions now use `MenuSurface`/`MenuItem` with an accessible menu label and runtime guard coverage in light/dark. | `src/renderer/ui/tags/TagBar.tsx`; `tests/e2e/design-system-runtime.spec.ts` |
| CA21 | Dream manual-run dialog was behavior-tested but absent from the shared runtime design-system guard. | Code drift | Runtime guard now opens the Dream channel manual-run dialog in light/dark through the channel picker and launcher surface. | `tests/e2e/design-system-runtime.spec.ts` |
| CA22 | Agent message metadata/details popover was behavior-tested but absent from the shared runtime design-system guard. | Code drift | Runtime guard now opens an assistant message Details dialog through the native context-menu bridge in light/dark. | `tests/e2e/design-system-runtime.spec.ts` |
| CA23 | The separate global launcher renderer used the shared token system but was absent from the shared runtime design-system guard. | Code drift | Runtime guard now opens `launcher.html` with a launcher IPC mock in light/dark while preserving the named native-glass exception for the real Electron window. | `tests/e2e/design-system-runtime.spec.ts`; `docs/spec/launcher.md` |
| CA24 | The day-panel date navigation calendar was distinct from field date pickers but absent from the shared runtime design-system guard. | Code drift | Runtime guard now opens the panel date calendar in light/dark through the main day panel shell. | `tests/e2e/design-system-runtime.spec.ts` |
| CA25 | Agent usage hover cards were portaled tooltip surfaces but absent from the shared runtime design-system guard. | Code drift | Runtime guard now opens the assistant message usage tooltip in light/dark through the real Details hover path. | `tests/e2e/design-system-runtime.spec.ts` |
| CA26 | Field-name reuse popovers were implemented through shared popover primitives and behavior-tested, but absent from the shared runtime design-system guard. | Code drift | Runtime guard now opens the field-name reuse popover in light/dark through the real outliner field creation path, without changing field-row layout or interaction behavior. | `tests/e2e/design-system-runtime.spec.ts` |
| CA27 | Options and reference field-value popovers were implemented through shared popover primitives and behavior-tested, but absent from the shared runtime design-system guard. | Code drift | Runtime guard now opens the option-value picker and reference-value node search in light/dark through real outliner field-value entries, without changing field-value layout or interaction behavior. | `tests/e2e/design-system-runtime.spec.ts` |
| CA28 | View-toolbar display and group configuration popovers were behavior-tested, while the shared runtime design-system guard only opened sort and filter. | Code drift | Runtime guard now opens display, group, sort, and filter view-configuration popovers in light/dark through the real toolbar. | `tests/e2e/design-system-runtime.spec.ts` |
| CA29 | Full preview header action menus used the shared menu primitive and focused file-preview behavior tests, but runtime design-system coverage only opened inline preview menus. | Code drift | Runtime guard now opens a file reader split pane and its header action menu in light/dark through the real preview flow. | `tests/e2e/design-system-runtime.spec.ts` |
| CA30 | View-toolbar tooltips were behavior-tested but absent from the shared runtime design-system guard. | Code drift | Runtime guard now opens a view-toolbar tooltip in light/dark through hover on the real toolbar. | `tests/e2e/design-system-runtime.spec.ts` |
| CA31 | Settings row action menus used the shared anchored menu primitive and behavior-tested triggers, but runtime design-system coverage only rendered settings rows closed. | Code drift | Runtime guard now opens a configured-provider row action menu in light/dark through the real Settings Providers surface. | `tests/e2e/design-system-runtime.spec.ts` |
| CA32 | Agent debug usage tooltips were behavior-tested but absent from the shared runtime design-system guard. | Code drift | Runtime guard now opens the debug run details pane and hovers the Call details usage tooltip in light/dark. | `tests/e2e/design-system-runtime.spec.ts` |
| CA33 | Selected option field-value popovers were behavior-tested, while runtime coverage only opened the empty-field option picker. | Code drift | Runtime guard now selects an option value and opens the selected-field-options popover in light/dark through the real field-value row. | `tests/e2e/design-system-runtime.spec.ts` |
| CA34 | Inline file hover previews were behavior-tested but absent from the shared runtime design-system guard, which only opened the inline file context menu. | Code drift | Runtime guard now inserts a local-file mention and opens its hover preview popover in light/dark through the real composer flow. | `tests/e2e/design-system-runtime.spec.ts` |
| CA35 | The composer model submenu was behavior-tested through model selection flows, while runtime coverage only opened the parent model menu and reasoning submenu. | Code drift | Runtime guard now opens the model submenu in light/dark through the real composer model control. | `tests/e2e/design-system-runtime.spec.ts` |
| CA36 | The implementation validation summary lagged behind the expanded runtime surface matrix. | Spec drift | Validation now summarizes the covered categories, including row menus, selected field values, inline-file preview/context, file-preview header menus, composer submenus, and agent/debug tooltips. | `implementation.md`, `tests/e2e/design-system-runtime.spec.ts` |
| CA37 | The runtime surface guard had many representative cases, but the metrics report could not quantify the matrix or fail when the matrix became undiscoverable. | Code drift | Metrics now report runtime surface cases and light/dark theme checks, and `--check` fails if the matrix is missing or empty. | `scripts/design-system-metrics.ts --json`; `tests/e2e/design-system-runtime.spec.ts` |

## Named Exceptions Kept

These are intentional after calibration. They stay narrow and evidence-backed.

| Exception | Scope | Evidence |
| --- | --- | --- |
| External document pixels may force a light canvas. | HTML/EPUB/PDF document content inside file previews only. | Kernel Exception Registry; file-preview visual/token guards |
| Scoped dark-media rules are allowed for generated colour streams. | Generated colour systems such as Shiki; no renderer theme bridge. | Kernel Exception Registry; typography/token guards |
| Global launcher uses vibrant system glass. | Separate launcher window only. | Kernel Exception Registry; launcher spec |
| Preview HUD controls own contrast tokens. | File preview HUD over arbitrary pixels. | `--preview-action-*` tokens; file-preview checks |
| Composer model/effort chip is a profile shortcut. | Agent composer footer only. | Kernel Exception Registry; composer tests |
| Icon masks and provider logos are identity assets. | Inline-file masks and provider marks only. | Kernel Exception Registry; icon/token review |
| `cursor: help` is allowed for diagnostics. | Inline diagnostic hints or native-title tooltips only. | Cursor guard |
| Native window rounding depends on compiled addon output. | macOS app-window corner visual verification. | Kernel Exception Registry; window-material checks |
| Model-upload JPEG alpha matting may force a white canvas. | Agent composer image resizing for model upload only. | Raw-hex named exception in metrics |

## Native-Control Exceptions

Product surfaces prefer primitives. These direct native controls remain named
because they carry native/editor semantics, not because they are styling shortcuts.
The metrics JSON owns the live counts and stale-entry gate.

| File | Reason |
| --- | --- |
| `src/renderer/ui/agent/AgentComposer.tsx` | Hidden file input plus editor-owned buttons inside the composer surface. |
| `src/renderer/ui/agent/AgentComposerControls.tsx` | Hidden file input delegated to the composer attachment flow. |
| `src/renderer/ui/agent/AgentEditor.tsx` | Native textarea used by the agent-profile editor draft model. |
| `src/renderer/ui/agent/AgentMarkdown.tsx` | Checkbox input inside rendered markdown/task-list content. |
| `src/renderer/ui/agent/AgentMessageRow.tsx` | Textarea used for in-place message editing. |
| `src/renderer/ui/outliner/CodeBlockRow.tsx` | Textarea/select pair required for the code-block editor overlay. |
| `src/renderer/ui/outliner/DateValuePicker.tsx` | Native date/time controls inside the date picker. |
| `src/renderer/ui/outliner/NodeDescriptionSurface.tsx` | Textarea follows the outliner description editing model. |
| `src/renderer/ui/outliner/NodeValuePicker.tsx` | Input is an anchored filtering control with caller-owned query semantics. |

## Open Design Decisions

No new open design decision is accepted by this calibration pass. The audit
intentionally avoided changing outliner layout or interaction behavior without a
directional product decision. Future proposed changes in these areas must be
treated as open design decisions before implementation:

| Area | Why it needs a decision |
| --- | --- |
| Outliner row geometry, leading marker behavior, selection behavior, and hover affordances | These are core product interactions that have been tuned over many rounds. |
| Any new colour role beyond neutral state, one link blue, one rose accent, and status colours | This changes the system's semantic colour model. |
| Any new material layer or per-surface blur value | This changes the two-layer material model and reduced-transparency fallback. |
| Any new native-control exception | This changes component coverage accountability and must be named before use. |
