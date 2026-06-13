# Keyboard Accessibility & Interaction Semantics

Layer-3 behavioral a11y, from UI review report E (`tmp/ui-review/E-keyboard-a11y.md`).
The boundary contract is `docs/plans/ui-quality-roadmap.md` — this plan is purely
**behavioral** (focus management, ARIA roles/state, arrow-key navigation). It does
**not** touch focus-ring CSS tokens, control shape, glass/radius, or any cosmetic
layer; those belong to `design-system-consistency` / `composition-rhythm` / the
primitive plans. CSS edits here are limited to whatever a roving-tabindex or
`:focus-visible` target needs to render correctly, nothing visual.

The codebase is already unusually strong on keyboard a11y for an Electron app, and
that is the starting point, not the problem. The shared primitives carry it:
`IconButton` *forces* an `aria-label` (`primitives/IconButton.tsx`), `Dialog`
bundles focus-trap + ESC + focus-restore (`primitives/Dialog.tsx`), and
`SegmentedControl` / `SwitchControl` / `CheckboxControl` are textbook ARIA widgets.
Surfaces built on those — Command Palette, Confirm/Dialog, Launcher — are excellent
and must be preserved. The gaps are concentrated in exactly two places that did
**not** go through those primitives:

1. **Floating popovers/menus built on `useAnchoredOverlay`, not `Dialog`.** Six of
   them hand-roll `createPortal` + a `role="menu"`/`"dialog"` div +
   document-level pointerdown/ESC, and so **never move focus into the overlay on
   open, never trap focus, never restore focus on close**, and (for the
   `role="menu"` ones) **have no arrow-key navigation** — the menu role
   over-promises keyboard behavior that isn't there. This is the single most
   repeated finding and the biggest leverage: fix it once, centrally.
2. **The outliner tree exposes no ARIA structure.** Rows are richly
   keyboard-drivable for sighted users (arrow nav, extend-select, indent, batch
   ops — all real, all in `useWorkspaceKeyboard.ts`) but carry no `role="tree"`/
   `treeitem`, `aria-level`, `aria-expanded`, or `aria-selected`, so a
   screen-reader user gets an unstructured pile of editable lines.

A secondary theme: a handful of custom widgets picked the "almost-right" ARIA role
(`aria-pressed` where `role="checkbox"`/`radio`/`tab` is the accurate mapping).

## Goal

- Give the six `useAnchoredOverlay` menus real keyboard semantics — focus-in on
  open, roving Arrow/Home/End navigation, ESC-to-close, and focus-restore to the
  trigger on close — via **one shared hook**, so the fix is mechanical and uniform
  rather than six divergent retrofits.
- Make the outliner tree legible to assistive tech: `role="tree"` container +
  `role="treeitem"` rows carrying `aria-level`, `aria-expanded` (when the row has
  children), and `aria-selected`, **without changing the existing sighted-user
  keyboard model**.
- Make the calendar month grid keyboard-navigable: `role="grid"` + roving-tabindex
  Arrow-key day movement + `aria-selected`/`aria-current` on selected/today cells.
- Correct the four role mismatches so the announced role matches the actual control.
- Preserve every "done well" item (Dialog, IconButton `aria-label`, Launcher /
  Command Palette listbox, SegmentedControl, TriggerPopover, AgentDock `inert`).

## Non-goals

- No focus-ring CSS tokens, control shape, overlay radius, glass, or any visual
  redesign (other plans own those; see the roadmap boundary contract).
- No new outliner keyboard *commands* — `useWorkspaceKeyboard.ts` is comprehensive
  and stays as-is; we add the *announced ARIA structure*, not new interactions.
- No migration of `Dialog`-based surfaces (Command Palette, Confirm, Launcher,
  Settings/Provider `BrowserWindow`s) — they are already correct.
- Not in scope this pass (left as the explicit "almost-right but acceptable"
  tail from the report): agent-settings categories `aria-current="page"` →
  tablist (acceptable as-is), agent-settings-view in-window ESC (Close button is
  reachable), search-query summary bar (already fine). These are noted so a
  reviewer knows they were considered and deferred, not missed.

## Design

Grouped by leverage. The shared menu hook is first because it closes most of the
gap table at once; tree ARIA second (the other High); calendar and role fixes last.

### 1. Shared menu-keyboard hook (biggest leverage) — `useMenuKeyboard`

**Problem (aggregate, High).** The repeated pattern in `useAnchoredOverlay.ts`
consumers never moves focus in, never traps, never restores, and the
`role="menu"` ones have no arrow-nav. Concretely, the six in scope:

| Menu | file:line | Current surface | What's missing |
|---|---|---|---|
| NodeContextMenu | `outliner/NodeContextMenu.tsx:431-448` (ESC/outside-close at 201-210; opener `OutlinerItem.tsx:1254-1269,1445`) | `MenuSurface role={main?'menu':'dialog'}`, `preserveSelection` | focus-in, roving arrow-nav, focus-restore (has ESC + outside-close) |
| Composer model menu | `agent/AgentComposerModelMenu.tsx:271-283` (`FloatingComposerMenu` 231-283; ESC/outside 252-269) | `MenuSurface role="menu"` (+ nested `menuitemradio`) | focus-in, roving arrow-nav, focus-restore (has ESC + outside-close) |
| Settings row `⋯` menu | `agent/SettingsRowMenu.tsx:101-126` (ESC/outside 95-99) | `MenuSurface role="menu"` + `menuitem`s | focus-in, roving arrow-nav, focus-restore (has ESC + outside-close; trigger already `aria-haspopup="menu"`+`aria-expanded`) |
| View-toolbar dropdowns | `outliner/ViewToolbar.tsx:323-346` (ESC/outside 245-261) | `div role="dialog"` + `aria-label` | focus-in, trap, focus-restore (has ESC + outside-close) |
| Agent session/history menu | `agent/AgentChatPanel.tsx:943-1047` (open 905; outside-close 708-718) | `div role="dialog"` + `aria-label` | **ESC** + focus-in + trap + focus-restore (only ESC today is inside the rename input, 979-982) |
| Date value picker | `outliner/DateValuePicker.tsx:257-264` (grid `primitives/CalendarMonthGrid.tsx`) | `div role="dialog"` + `aria-label` | focus-in, trap, focus-restore (has ESC + outside-close; grid arrow-nav handled in §3) |

**Target.** A single hook (working name `useMenuKeyboard`) that any
`useAnchoredOverlay` overlay opts into, layered on top of the existing
anchored-position style. It owns four behaviors, mirroring what `Dialog` already
does well but for the menu (not modal-dialog) idiom:

- **focus-in on open** — on mount, focus the surface (or its first focusable
  item), `preventScroll: true`, matching `Dialog.tsx:50-53`.
- **focus-restore on close** — capture `document.activeElement` (or an explicit
  `restoreFocus` target = the trigger) on mount; refocus it on unmount if still in
  the document, exactly the `Dialog.tsx:55-63` pattern. This is the *most systemic*
  miss — none of the six restore today.
- **ESC-to-close** — invoke `onClose`; consolidates the per-menu ESC listeners and
  closes the **agent session menu's** notable ESC gap.
- **arrow-nav (roving)** — for `role="menu"` surfaces: `ArrowDown`/`ArrowUp` move a
  roving `tabIndex` across the menu items (skip disabled / separators), `Home`/`End`
  jump to ends, `Enter`/`Space` activate. Item discovery is by querying focusable
  descendants of the surface (same `FOCUSABLE_SELECTOR` approach as
  `Dialog.tsx:16-28`), so `MenuItem`/`ButtonControl` children need no per-call
  wiring. For `role="dialog"` popovers (view-toolbar, date picker, session menu)
  the hook provides focus-trap (Tab/Shift+Tab wrap) instead of roving menu-nav,
  since their content is heterogeneous form controls rather than a flat menu list.

**Shape (decided locally, recorded here; reviewable).** The hook takes the
overlay ref, the trigger ref (for restore), `onClose`, and a `kind: 'menu' |
'dialog'` discriminator selecting roving-nav vs trap. It returns nothing (pure
effect) or a small `{ onKeyDown }` to spread on the surface — settle at build time
against whichever reads cleaner; it is a private helper, not a contract surface.
It must respect `preserveSelection` (NodeContextMenu sets it) and the IME-guard
convention (`isImeComposingEvent`) already used across the editor so it never
swallows composition keystrokes.

**Retrofit.** Wire all six surfaces above to the hook, passing their existing
trigger ref as the restore target:

- NodeContextMenu: trigger is a context-menu (pointer/menu-key) at click coords,
  so "restore" returns focus to the row/editor the menu was opened from
  (`OutlinerItem.tsx:1254-1269` blurs activeElement on open — capture the prior
  element there). Submode switches (`role` → `dialog` at 437) keep focus inside.
- Session menu: pass `historyButtonRef` (`AgentChatPanel.tsx:901`) as restore
  target; this also fixes the missing ESC.
- Model menu / SettingsRowMenu / view-toolbar / date picker: pass the existing
  anchor/trigger ref each already holds.

This is where A7 (foundation before consumers) applies in-plan: land the hook +
its tests first, then convert the six call sites.

### 2. Outliner tree ARIA (High, SR-blocking structure)

**Problem.** `outliner/OutlinerFlatView.tsx:492` renders a plain
`<div className="outliner-flat">`; rows go through `OutlinerRowShell.tsx:24-35`
(the `row-wrap` / `rowClassName` divs) via `OutlinerItem.tsx:1435-1468`. None carry
tree roles or state — selection/expansion is class-only and invisible to SR.

**Target.**

- Container: `role="tree"` on `outliner-flat` (`OutlinerFlatView.tsx:492`) and the
  non-virtualized fallback (`:487`), plus `aria-label`/`aria-multiselectable="true"`
  (the outliner supports multi-select).
- Row: `role="treeitem"` on the `OutlinerRowShell` wrapper (`OutlinerRowShell.tsx:24`,
  fed from `OutlinerItem.tsx`), with:
  - `aria-level` — depth (already known to the layout; thread it via the shell
    props so the shell stays presentational).
  - `aria-expanded` — only when the row `hasChildren` (the shell already receives
    `hasChildren`/`expanded`, `OutlinerRowShell.tsx:3-12`) — omit on leaf rows so
    SR doesn't announce a non-existent toggle.
  - `aria-selected` — reflect the `selectedIds` membership the row already computes.
- `OutlinerFieldRow.tsx` (the other `OutlinerRowShell` consumer) gets the same
  treatment so field rows aren't an unstructured hole in the tree.
- **Virtualization caveat:** when virtualized, rows are wrapped in `FlatRowShell`
  and only a window is in the DOM (`OutlinerFlatView.tsx:493-501`). `aria-setsize`/
  `aria-posinset` would be needed for SR to announce "item N of M" correctly with a
  windowed DOM; whether to add them is a deferred decision (see below) — the base
  `role`/`level`/`expanded`/`selected` are the must-haves and are independent of it.

Crucially, this is **additive** — no change to `useWorkspaceKeyboard.ts` or the
contentEditable interaction. The sighted keyboard model is preserved verbatim; we
only announce structure.

### 3. Calendar month grid (Med) — `primitives/CalendarMonthGrid.tsx`

**Problem.** `CalendarMonthGrid.tsx:69-96` renders days as a flat list of
`ButtonControl`s inside `div.calendar-month-grid`. Each day is its own tab stop;
there is no `role="grid"`, no Arrow-key day movement, and selected/today state is
class-only (`is-selected`/`is-today`, `:83-85`) with no `aria-selected`/
`aria-current`.

**Target.**

- `role="grid"` on `calendar-month-grid` (`:69`); wrap each week in a `role="row"`
  and each day cell in `role="gridcell"` (or set the cell role on the day button —
  decide at build).
- Roving tabindex: exactly one day is `tabIndex={0}` (the selected day, else today,
  else the first in-month day); the rest are `-1`. Arrow keys move the roving focus
  ±1 day / ±7 days (week) with `Home`/`End` to row ends and `PageUp`/`PageDown`
  to month; reuse `addLocalDays` / `buildCalendarMonthDays` (`:111-124`) and the
  existing `onMoveMonth` to cross month boundaries when navigation runs off the
  current grid.
- `aria-selected` on selected cells (drive from `selectedDates`, `:43`) and
  `aria-current="date"` on the today cell (`day.isoDate === todayIsoDate`, `:83`).
- Because `CalendarMonthGrid` is shared, this fixes both `DateValuePicker`
  (`outliner/DateValuePicker.tsx:257-264`) and any other consumer in one edit; the
  date-picker popover's focus-in/trap/restore is handled by §1.

### 4. Role mismatches (Low — announced role ≠ actual control)

Each is a localized swap; behavior unchanged, only the role/state mapping corrected
to match the textbook widget the app already ships elsewhere (`SegmentedControl`,
`CheckboxControl`).

- **DoneCheckbox interactive variant** — `outliner/DoneCheckbox.tsx:32-48` is a
  button with `aria-pressed`; the read-only variant (`:19-30`) already uses
  `role="checkbox"`+`aria-checked`. Target: make the interactive variant
  `role="checkbox"`+`aria-checked` too (or a real hidden `<input type=checkbox>`),
  so the same control announces consistently. Add Space-to-toggle if not inherited.
- **View-toolbar single-select options** — `outliner/ViewToolbar.tsx:824-837`:
  single-select (`variant: 'radio'`) options are `aria-pressed` buttons inside a
  labelled `<div>`. Target: `role="radiogroup"` on the group + `role="radio"`+
  `aria-checked` on options with roving tabindex + Arrow move-select, matching
  `SegmentedControl`. (The `'checkbox'` variant stays a checkbox — multi-select.)
- **Subagent details tabs** — `agent/AgentSubagentDetailsPanel.tsx:498-509`: a
  `<nav>` of `aria-pressed` `ButtonControl`s. Target: `role="tablist"` +
  `role="tab"`+`aria-selected`+`aria-controls`, the panel body `role="tabpanel"`,
  with Arrow-key tab navigation. Panel stays non-modal (`<aside>`, acceptable).
- **Command-palette input** — `CommandPalette.tsx:180-207` has
  `aria-activedescendant`/`aria-controls` but no `role="combobox"`/`aria-expanded`/
  `aria-autocomplete`. Target: add those three, mirroring Launcher
  (`src/renderer/launcher/LauncherApp.tsx` — a separate `BrowserWindow` renderer
  root, **not** under `ui/`; `role="combobox"`/`aria-autocomplete="list"` at
  `:206`/`:209`), which sets all of them. (Listbox below at `:208` is already
  correct.)

## Decisions deferred

These are directional/taste or scope calls — defaults proposed, but flag to the PM
at plan-ratify time rather than guess (escalate-don't-guess):

1. **Shared hook vs migrate menus to a `Dialog` variant.** The report offers both:
   a `useMenuKeyboard` roving-focus hook **or** routing the overlays through a
   menu-aware variant of `Dialog`. **Default: build the hook.** Rationale — the six
   overlays already depend on `useAnchoredOverlay` for anchored (non-centered)
   positioning that `Dialog` (backdrop + centered modal) does not provide;
   composing a focus-behavior hook over the existing positioning hook is less
   invasive than reworking `Dialog` to also be a non-modal anchored menu, and keeps
   `Dialog` focused on true modals. (Confirm before building — this is the
   load-bearing structural call.)
2. **Tree ARIA scope under virtualization.** Whether to add `aria-setsize`/
   `aria-posinset` for correct "item N of M" SR announcement with a windowed DOM
   (`OutlinerFlatView` virtualization), or ship `role`/`level`/`expanded`/`selected`
   first and treat set-size as a follow-up. **Default: ship the base roles/state
   now; defer set-size** unless the live SR test (below) shows the windowed DOM
   actively misleads (e.g. announces wrong counts) rather than merely omits them.
3. **Field rows + tree role granularity.** Whether `OutlinerFieldRow` rows are
   `treeitem`s in the same tree or a nested `group`/`row` idiom. **Default: same
   `treeitem` tree** for a flat announced structure; revisit only if SR testing
   shows confusion.
4. **DoneCheckbox: `role=checkbox` vs real `<input>`.** Default to the role+
   `aria-checked` swap (smallest diff, matches the read-only twin); a real hidden
   input is the fallback if Space-activation or form semantics need it.

## Collision check

Ran `gh pr list` + scanned `docs/TASKS.md` boundary + grepped the target files
against open-PR scopes on 2026-06-05.

- **#119** (`cc/incremental-projection`) — owns `src/core/types.ts`, main boundary,
  and renderer **state** (`state/document.ts`, `renderRev.ts`, `App.tsx`). This
  plan touches **renderer UI** components only (`ui/outliner/*`, `ui/agent/*`,
  `ui/primitives/*`) — no overlap. `OutlinerFlatView.tsx` is a render/virtualization
  view, not the projection-store files #119 reshapes.
- **#118** (`codex/settings-macos-clarity`) — owns `AgentSettingsView.tsx`,
  `SelectControl.tsx`, `SettingsInsetList.tsx`, `settings-*.css`,
  `design-system.md`. This plan touches `AgentSettingsView.tsx` **only** in the
  deferred/non-goal tail (categories tablist), which is explicitly out of scope, so
  there is **no edit overlap**. `SettingsRowMenu.tsx` (in scope here) is not in
  #118's claim.
- No overlap with the sibling Layer-3 plans: `responsive-robustness` (pane/resize
  layout), `icon-semantics` (icon↔action mapping) — different files and concerns.
- Within the roadmap boundary contract: this plan is behavioral; it does **not**
  edit context-menu glass/radius (`composition-rhythm` owns that on
  `node-context-menu`), focus-ring tokens, or button shape/fill
  (`design-system-consistency` / `button-primitive`). Where a role swap (§4) and a
  cosmetic plan both name the same file (e.g. `ViewToolbar.tsx`, `DoneCheckbox.tsx`),
  the edits are orthogonal (ARIA attributes vs CSS/shape) — coordinate ordering at
  the gate, no contention on the same lines.

**Result: no real conflict.** No shared/protocol file is touched (no
`src/core/commands.ts`/`types.ts`), so no interface-first PR is needed.

## Risks

- **Focus-management regressions need live keyboard testing.** Focus-in /
  trap / restore is exactly the class of behavior that unit tests (jsdom) verify
  weakly — jsdom's focus and `:focus-visible` semantics differ from a real
  browser/Electron. Restoring focus to the wrong element, stealing focus from the
  editor caret, or breaking the `preserveSelection` escape hatch
  (`[data-preserve-selection]`, used by NodeContextMenu) are all silent until a
  human drives the keyboard. **Mitigation:** the checklist mandates a live
  keyboard + screen-reader pass on every retrofitted surface (the report flags 8
  of these "Needs live test: Yes").
- **NodeContextMenu's blur-on-open** (`OutlinerItem.tsx:1257-1259,1240-1242`)
  deliberately blurs the editor; the restore target must be captured *before* that
  blur, or focus-restore returns to `<body>`. Handle in the opener, not the hook.
- **IME composition** — the hook's keydown must guard with `isImeComposingEvent`
  (the convention across `useWorkspaceKeyboard.ts` / `CommandPalette.tsx:190`) so
  Arrow/ESC during CJK composition aren't hijacked. The i18n work just landed on
  this branch's lineage; CJK input is a first-class path.
- **Roving tabindex + virtualization** — the calendar grid is fully in-DOM (42
  cells, safe); the outliner tree is virtualized, so we must **not** add a roving
  tabindex there (its focus lives in the contentEditable model already) — tree
  ARIA is attributes-only, no tabindex change. Keep these two mechanisms separate.
- **Don't regress the good surfaces** (B11 spirit): the `Dialog`/Launcher/Command
  listbox patterns are the reference; changes must leave them byte-identical in
  behavior. Guard tests / e2e that assert their ARIA must stay green.

## Checklist

Foundation first (A7), then consumers, then the independent fixes.

- [ ] Build `useMenuKeyboard` (focus-in, restore, ESC, roving-nav for `menu` /
      trap for `dialog`); IME-guarded; `preserveSelection`-aware. Unit-test the
      roving logic (item discovery, skip disabled/separator, Home/End wrap).
- [ ] Retrofit the six overlays: NodeContextMenu, model menu, SettingsRowMenu,
      view-toolbar dropdowns, agent session menu (also fixes its ESC gap), date
      picker. Pass each one's trigger ref as the restore target.
- [ ] Tree ARIA: `role="tree"` container (`OutlinerFlatView.tsx` virtualized +
      fallback) + `role="treeitem"` + `aria-level`/`aria-expanded`(when children)/
      `aria-selected` via `OutlinerRowShell` (both `OutlinerItem` and
      `OutlinerFieldRow` consumers). No change to `useWorkspaceKeyboard.ts`.
- [ ] Calendar grid: `role="grid"`/`row`/`gridcell`, roving-tabindex Arrow/Home/
      End/Page day nav crossing month boundaries, `aria-selected`/`aria-current`.
- [ ] Role fixes: DoneCheckbox interactive → checkbox; view-toolbar radios →
      radiogroup; subagent tabs → tablist/tab/tabpanel; command-palette input →
      combobox.
- [ ] `bun run typecheck` + `bun run test:renderer` green; extend/refresh any a11y
      guard or e2e that asserts roles on these surfaces.
- [ ] **Live keyboard + screen-reader pass** (VoiceOver on macOS) on every
      retrofitted surface: open via keyboard, Arrow-navigate, ESC, confirm focus
      returns to the trigger; confirm the tree announces level/expanded/selected
      and the calendar announces grid day-to-day movement. This is the gate — the
      jsdom tests do not cover focus reality.
- [ ] Update `docs/spec/` for the now-intended ARIA contract of menus, tree, and
      calendar (A6 — spec ⇄ code in the same change); fold this plan's Design into
      the relevant spec doc on ship and flip status `done` → `archive/`.
