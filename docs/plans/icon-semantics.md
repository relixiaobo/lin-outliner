---
status: draft
priority: P3
owner: relixiaobo
created: 2026-06-05
updated: 2026-06-05
---

# Icon Semantics — action↔icon collision fixes

The renderer's icon layer is already strong and single-sourced: every product
glyph resolves through one lucide alias table (`src/renderer/ui/icons.ts`), the
field-type vocabulary flows through one `FIELD_TYPE_ICONS` map
(`src/renderer/ui/outliner/fieldTypePresentation.tsx`), and inline file mentions
go through one `inlineFileIconKind` resolver (`src/renderer/ui/editor/inlineFileIcon.ts`).
There are **no rogue `from 'lucide-react'` imports** anywhere in the renderer
(verified by grep in report G). Because of that, this is **not** a "scatter of
inconsistent icons" cleanup — it is a small set of **semantic-mapping fixes**:
a handful of cases where one lucide glyph is aliased to two unrelated meanings,
or where a resolver's fallback reaches for a glyph that already carries a
different meaning. The fixes are centralized and cheap — almost all live in
`icons.ts` plus a few resolver lines — and carry near-zero behavioral risk
(glyph swaps, no logic change).

This is **Layer 3, P3** in `docs/plans/ui-quality-roadmap.md` — independent of
the cosmetic Layer-1/2 work and runnable anytime (it touches no shared CSS
tokens, no primitives, no protocol surface).

Source report: `tmp/ui-review/G-icon-semantics.md` (gitignored). This plan
distills report G's divergence list D2–D12 + the §3 chevron note into actionable
work and OWNS them; no other roadmap plan touches icon glyph choices.

## Goal

Make each distinct **action / concept** map to a distinct **glyph**, so a glyph
never silently implies the wrong meaning (a successful tool drawn as an error
triangle; "open in split pane" drawn as "leave the app"; a number field and a
supertag drawn identically). Concretely:

- Split every alias collision where one lucide glyph backs two unrelated
  semantic names, when those meanings can co-occur in the user's view.
- Replace resolver fallbacks that borrow a status/settings glyph with a neutral
  glyph (unknown-tool, generic config row).
- Route agent attachment icons through the single-sourced `inlineFileIconKind`
  so a `.zip`/`.xlsx`/`.mp4` chip and the same file's inline mention agree.
- Keep the central-table architecture intact (no new rogue imports; new glyphs
  are added as aliases in `icons.ts`).

## Non-goals

- No new icon-rendering mechanism, no `<Icon>` primitive, no size/stroke token
  changes — those passed review elsewhere and are out of scope.
- No CSS / `inline-ref.css` mask changes — the inline file masks are coherent;
  D12 is a TSX-side routing fix, not a mask change.
- No protocol / `src/core` changes, no behavior change beyond which glyph renders.
- Not re-opening the chevron disclosure-vs-nav convention or the launcher
  CirclePlus question as code changes — those stay **note-only** (see Deferred).
- No i18n/copy changes; labels stay as-is.

## Design

### Decision table

Grouped by severity, **user-facing first**. "Current" is the glyph rendered
today; "Proposed" is the new glyph (lucide name). All `icons.ts` line refs are
against the current file. The recommended choices are spelled out under
**Decisions deferred** where a taste call is involved.

#### Tier 1 — user-facing collisions (a glyph implies the wrong thing)

| # | Collision | Current | Proposed glyph | file:line |
|---|---|---|---|---|
| G1 | `Hash` aliases BOTH `HashIcon` (number field-type) AND `SupertagIcon` (schema/supertag) — a `#` means "number" in a field list but "supertag" in nav/tag surfaces | `HashIcon = Hash`, `SupertagIcon = Hash` | keep `#` (`Hash`) for **supertag** (tag convention); give **number field** a distinct glyph → `SupertagIcon` stays `Hash`, `HashIcon` (number) → `Binary` (recommend) | `icons.ts:47-48`; consumers: number via `fieldTypePresentation.tsx:28`; supertag via `NodeContextMenu.tsx:309`, `DefinitionConfigPanel.tsx:142`, Sidebar/CommandPalette schema nav |
| G2 | Unknown-tool fallback renders `WarningIcon` (AlertTriangle) — a **successful** call to an un-iconned tool looks like an **error** | `return WarningIcon` | neutral generic-tool glyph → `Wrench` (recommend); reserve AlertTriangle for real error/warning status (B4 spirit) | `AgentToolCallBlock.tsx:93` (`getToolIcon` fallback) |
| G3 | Agent user-attachment icons use a coarse 3-way map (directory→Folder, image→FileImage, else→FileText) — a `.zip`/`.xlsx`/`.mp4` chip shows a generic text glyph, while the **same file** as an inline mention shows archive/spreadsheet/video | hand-rolled `iconForUserAttachment` switch | route through `inlineFileIconKind` (the single source) and map its 10 kinds to the matching `File*Icon` aliases | `AgentMessageRow.tsx:184-188` |
| G4 | `OpenIcon` (ExternalLink) is overloaded: "open in **split pane**" (in-app) shares the arrow-out-of-box glyph with genuinely-external links (OAuth/config browser opens, open image, open link) | `<OpenIcon>` for split-pane | use a panel/split glyph for in-app split-open → `Columns2` (recommend; app already uses `PanelRight`/`PanelLeft` for rails); keep `OpenIcon`=ExternalLink strictly for actions that leave the app | split-pane: `NodeContextMenu.tsx:263`; external (unchanged): `ProviderOAuthForm.tsx`, `ProviderConfigForm.tsx`, `ImageRow.tsx:109`, `OutlinerItem.tsx:1673` |

#### Tier 2 — adjacent-surface inconsistency (same noun, different glyph)

| # | Collision | Current | Proposed glyph | file:line |
|---|---|---|---|---|
| G5 | "Remove tag" drawn as `CloseIcon` (X) in the TagBar context menu, but tag-delete drawn as `TrashIcon` in AppliedTag — adjacent surfaces, same noun ("tag"), different glyph | TagBar `Remove` → `CloseIcon`; AppliedTag trashed badge → `TrashIcon` | codify the rule **X = detach/dismiss a transient chip or close UI; Trash = destroy persisted data**, then re-audit. "Remove tag" detaches the tag from a node (not destroying the tag entity) → X is correct; **no glyph change**, document the rule in `icons.ts` and leave AppliedTag's trashed-state Trash as-is | TagBar `removeTitle`: `TagBar.tsx:121`; AppliedTag trashed: `AppliedTag.tsx:31`; AppliedTag detach X: `AppliedTag.tsx:63` |

#### Tier 3 — alias collisions to watch / dead alias (low / non-user-facing)

| # | Collision | Current | Proposed glyph | file:line |
|---|---|---|---|---|
| G6a | `Square` aliases BOTH `CheckboxIcon` (unchecked checkbox) AND `StopIcon` (agent stop) | both `= Square` | low risk (Stop is rendered as a styled filled square button; checkbox lives in a checkbox row) → **keep both; add a comment** noting the deliberate share. Optional: `StopIcon` → `Square` stays, document. No change recommended | `icons.ts:24,87`; Stop: `AgentComposerControls.tsx:168`; checkbox: `NodeContextMenu.tsx:300`, field-type |
| G6b | Two "edit" glyphs: `PencilIcon` (Pencil) for message/text edit vs `DescriptionIcon`/`NodeEditToolIcon` (FilePenLine) for edit-description / node-edit-tool | `PencilIcon=Pencil`, `DescriptionIcon=NodeEditToolIcon=FilePenLine` | **deliberate distinction** — Pencil = edit free text (message, composer), FilePenLine = edit a structured node's description/content. **Keep both; document** the split in `icons.ts`. No change | Pencil: `AgentComposerControls.tsx:32`, `AgentMessageRow.tsx:503`, `AgentChatPanel.tsx:1022`; FilePenLine: `NodeContextMenu.tsx:329`, `getToolIcon:79,92` |
| G6c | `SettingsIcon` (gear) doubles as the **generic config-row fallback** in DefinitionConfigPanel — a gear on a config row reads as "settings for this row" rather than "misc property" | `autoInitialize` + catch-all `return <SettingsIcon>` | give the catch-all a neutral glyph distinct from the app-settings gear → `SlidersHorizontal` (recommend) for the catch-all; keep `SettingsIcon` for actual Settings entry points | `DefinitionConfigPanel.tsx:148` (`autoInitialize`), `:153` (catch-all) |
| G7 | `RefreshIcon` (RefreshCw) exported but **zero JSX usages** (dead alias) | `RefreshCw as RefreshIcon` | **drop the alias** to keep the map honest (A8). If a refresh action is wanted later, re-add then | `icons.ts:81` |

### Implementation shape

- **icons.ts is the hub.** G1 (number→`Binary`), G2 (add a `GenericToolIcon`/
  reuse `Wrench`), G4 (add a split-pane alias e.g. `SplitPaneIcon = Columns2`),
  G6c (add `MiscConfigIcon = SlidersHorizontal`), and G7 (delete `RefreshIcon`)
  are all alias-table edits. New glyphs are added as **named aliases** so the
  one-table architecture is preserved — call sites import the semantic name,
  never the raw lucide name.
- **Resolver edits (3 lines):** `getToolIcon` fallback (G2),
  `iconForUserAttachment` rewrite to consume `inlineFileIconKind` (G3),
  `ConfigIcon` catch-all + `autoInitialize` (G6c).
- **Call-site edit (1 line):** `NodeContextMenu.tsx:263` swaps `OpenIcon` →
  the new split-pane alias (G4).
- **Comments only:** G5 (rule comment in `icons.ts` near `CloseIcon`/`TrashIcon`),
  G6a / G6b (deliberate-share comments near the aliases). These change no
  rendered glyph.

### Spec sync (A6)

Icon semantics aren't currently codified in `docs/spec/`. This plan adds a short
**"Icon semantics"** subsection to `docs/spec/design-system.md` (the visual
authority) recording the load-bearing rules this plan establishes:
`#`=supertag-only, number-field gets its own glyph; AlertTriangle = status-only
(never a neutral fallback); split-pane ≠ external-link; X = detach/dismiss,
Trash = destroy; the deliberate Pencil-vs-FilePenLine and Square-share notes.
Done in the same change. (If #118 still owns `design-system.md` at build time,
land this spec paragraph behind #118 per the roadmap's dependency note, and keep
the code change ahead of it.)

## Decisions deferred

Each row below recommends a default but flags it as a **taste call** the PM can
overturn at plan-ratify time. Picking these is a one-minute decision; the build
follows whatever is chosen.

- **G1 — number-field glyph.** Recommend `Binary` (reads as "numeric data",
  visually distinct from `#`). Alternatives: `Calculator`, `Sigma` (already used
  as `FormulaIcon` — avoid), or invert the split (number keeps `#`, supertag
  gets `Tag`/`Tags`). Recommendation keeps the `#`=tag convention users expect.
  *Taste call: which side of the `#` collision moves.*
- **G2 — unknown-tool glyph.** Recommend `Wrench` (generic "tool"). Alternatives:
  `Terminal` (already `TerminalIcon` for bash — avoid), `CircleDot`/`Dot`
  (neutral marker), `Box`. *Taste call: tool-flavored (`Wrench`) vs neutral dot.*
- **G4 — split-pane glyph.** Recommend `Columns2` (two side-by-side panes =
  split). Alternative: `PanelRight` (already `AgentToggleIcon`) or `PanelLeft`
  (already `SidebarToggleIcon`) — reusing those risks a *new* collision with the
  rail toggles, so a fresh `Columns2` is cleaner. `SplitSquareHorizontal` also
  available. *Taste call: confirm `Columns2` reads as "open beside" not "table".*
- **G6c — generic config-row glyph.** Recommend `SlidersHorizontal` (a "misc
  property/adjust" glyph distinct from the Settings gear). Alternative: `Cog`
  (too close to `Settings`), `CircleDot`. *Taste call: low stakes.*
- **G5 / G6a / G6b — documented as deliberate, not changed.** Default is
  **comment-only** (no glyph swap). If the PM wants "Remove tag" to use Trash
  (G5), or a single edit glyph (G6b), that's a swap instead — flag for the PM.

## Collision check

- `gh pr list` + scan of `docs/TASKS.md` + grep of the intended files against
  open-PR scopes: this plan's edits are confined to `src/renderer/ui/icons.ts`,
  three resolver files (`AgentToolCallBlock.tsx`, `AgentMessageRow.tsx`,
  `DefinitionConfigPanel.tsx`), one call site (`NodeContextMenu.tsx`), and a
  spec paragraph in `design-system.md`.
- **Roadmap boundary contract** (`docs/plans/ui-quality-roadmap.md`): no other
  Layer-1/2/3 plan touches icon glyph choices — `composition-rhythm` owns
  context-menu glass/radius (not its item glyphs), `button-primitive` owns button
  shape (not icons), `feedback-states` owns empty/error *idioms* (it may render
  `WarningIcon` for error states — **unaffected**, G2 only changes the
  unknown-tool *fallback*, not error states). No overlap.
- **`design-system.md` is co-owned with PR #118** (codex settings-macOS-clarity).
  Only risk: the spec-paragraph edit. Mitigation: land the spec paragraph behind
  #118 (code change can land ahead). Flagged per the roadmap dependency note.
- Result: **no overlap.** The only shared file is `design-system.md` (spec
  paragraph only), sequenced behind #118.

## Risks (low)

- **Glyph-only changes, no logic.** Each fix swaps which icon component renders;
  no data flow, no command, no IPC changes. Blast radius is visual.
- **Guard tests (B11).** The token/hex/elevation guards check CSS, not lucide
  aliases — adding/removing aliases in `icons.ts` doesn't trip them. New imports
  stay inside the central table, so the "no rogue `lucide-react` import" property
  is preserved.
- **G3 mapping breadth.** Routing attachments through `inlineFileIconKind`
  introduces 10 kinds where there were 3; need the kind→`File*Icon` map to cover
  all ten (archive, audio, code, database, folder, image, presentation,
  spreadsheet, text, video) with a `text`→`FileTextIcon` default. Low risk; the
  aliases already exist in `icons.ts` (FileArchive/Audio/Code/Image/Spreadsheet/
  Video, Folder, Database; presentation→`PresentationIcon`).
- **Dead-alias removal (G7).** Confirm zero usages before deleting (report G
  grepped zero; re-grep at build). Reversible.
- **Verification.** Visual check (light + dark) of: a number field row vs a
  supertag, an unknown agent tool call, a `.zip`/`.xlsx` attachment chip, the
  node context-menu "Open in split pane" item, a definition-config catch-all row.

## Checklist

- [ ] **G1** number-field glyph: split `HashIcon`/`SupertagIcon` in `icons.ts`
  (number → chosen glyph; supertag keeps `Hash`); verify `fieldTypePresentation`
  + all supertag consumers.
- [ ] **G2** `getToolIcon` fallback → neutral generic-tool glyph
  (`AgentToolCallBlock.tsx:93`); add the new alias to `icons.ts`.
- [ ] **G3** rewrite `iconForUserAttachment` (`AgentMessageRow.tsx:184-188`) to
  consume `inlineFileIconKind` + a kind→`File*Icon` map.
- [ ] **G4** add split-pane alias to `icons.ts`; swap `NodeContextMenu.tsx:263`.
- [ ] **G6c** `ConfigIcon` catch-all + `autoInitialize`
  (`DefinitionConfigPanel.tsx:148,153`) → neutral config glyph; add alias.
- [ ] **G7** delete unused `RefreshIcon` alias (`icons.ts:81`) after re-grep.
- [ ] **G5 / G6a / G6b** add documenting comments in `icons.ts` (detach-vs-destroy
  rule; Square share; Pencil-vs-FilePenLine deliberate split) — no glyph change
  unless PM overrides.
- [ ] Spec: add "Icon semantics" subsection to `docs/spec/design-system.md`
  (sequenced behind #118 if it still owns the file).
- [ ] `bun run typecheck` + `bun run test:renderer`.
- [ ] Visual verification (light + dark) per the Risks list.
