# Responsive Robustness

Layer 3 of the UI-quality roadmap (see `docs/plans/ui-quality-roadmap.md` — this
plan OWNS report D's findings). Unlike the cosmetic layers, **this is a
behavioral bug-fix plan, not a polish pass.** The headline is a real, reproducible
defect: at small window widths the two floating rails (sidebar + agent) reserve
more horizontal room than the window has, and because the canvas is
`overflow:hidden` on both axes there is **no horizontal scrollbar to rescue the
content** — the reading pane silently crushes under its own gutters until it is
unusable, with no visible cause and no obvious fix for the user. That is a bug,
and it out-ranks every cosmetic item in the roadmap (P1, highest user-impact).

The shell is not a width-reserving grid. `.workspace-canvas` is
`position:absolute; inset:0` and reserves room for the rails purely with
**padding** that tracks the rail-width CSS vars (`canvas.css:30-32`):

- `--canvas-pad-left  = layout-gap(8) + --sidebar-width + layout-gap(8)`
- `--canvas-pad-right = layout-gap(8) + --agent-width   + layout-gap(8)`

The rails are clamped **independently** to their own min/max
(`useResizableLayout.ts:63,108`); nothing validates `sidebarWidth + agentWidth`
against the window width, nothing re-clamps when the window shrinks, and panes are
`flex: … min-width:0` so they collapse to a sliver rather than forcing a scroll
(`canvas.css:71-72`). The same "size never checked against available width"
pattern recurs in five smaller places (multi-pane gating, outline indent, sidebar
indent, the inline tag-bar, the breadcrumb). This plan fixes all of them.

This work is mostly TSX (the `useResizableLayout` / `useWorkspaceLayout` hooks)
plus a little CSS. Several fixes touch live drag/resize math, which reading alone
cannot validate — those are flagged **(needs live resize smoke test)** throughout
and gathered into one smoke-test checklist item at the end.

## Goal

- The reading pane can never be crushed below a usable floor by the rails: at any
  window width ≥ the native `minWidth` (760), the leftover canvas inner width for
  the pane stays ≥ `--outline-panel-min-width` (360), OR the rails are shrunk
  to make room. No silent crush.
- Rail widths re-clamp when the window narrows (a 520px agent must not persist
  into a 760px window).
- Opening / persisting a pane is gated on **available width**, not just pane count.
- Deep outline indentation (and the mirrored sidebar tree indentation) is capped
  so a deep subtree in a narrow pane keeps a legible content column.
- The inline tag-bar wraps or overflows gracefully on non-plain rows and the
  page-title toolbar instead of spilling horizontally.
- Breadcrumb collapse is driven by available width, not only by segment count, so
  the last (current-context) segment stays readable.

## Non-goals

- **No re-architecture of the floating-rail / padded-canvas model** into a
  width-reserving grid. The `position:absolute` rails + canvas padding model
  (canvas.css) stays; we add guards on top of it. (A7: don't fight the foundation;
  B5: the two-layer material model is intentional.)
- **No new horizontal scrollbar on the canvas.** `overflow:hidden` on both axes is
  deliberate (full-bleed content base under floating chrome); the fix is to keep
  content within bounds, not to add a scroller. (Confirm in the smoke test that we
  never introduce one.)
- **No change to the rail min/max constants or the native window `minWidth:760`**
  unless the smoke test proves 760 cannot host even the narrowest layout + a 360
  pane (it can: 168 + 296 = 464 reserved, 296 leftover — see the deferred
  decision on whether 296 < 360 needs the floor to win over the rail mins).
- No new persisted settings, no telemetry, no responsive "breakpoint" system.
- Truncation idioms that already degrade gracefully (the long list of `YES` rows
  in report D — node title wrap, model-name ellipsis, agent prose wrap, settings
  rows) are **not** touched; this plan only fixes the `NO` / `degrades` / `partial`
  rows.

## Design

One section per defect. Each gives current behavior + `file:line`, the proposed
fix, and the approach. Defects 1–3 share the `useResizableLayout` /
`useWorkspaceLayout` hooks and the canvas-width measurement, so they are designed
together; 4–6 are independent.

**Execution (complete-per-PR).** Shape (b): not one "responsive" feature sliced
into seven steps, but a set of complete fixes. **D1–D3 ship together as one
complete PR** (they're interdependent through the shared width hooks — D1 without
D2 leaves resize broken, so none is shippable alone). **D4, D5, D6, D7 each ship
as their own complete PR** (independent localized fixes). No PR lands a partial
slice that needs a follow-up to be coherent.

### D1 — Rail sum is never validated against window width (the pane-crush bug)

**Current behavior.** `sidebarWidth` and `agentWidth` are independent React state
(`useResizableLayout.ts:49-50`), each clamped only to its own min/max during drag
(`:63` sidebar → `[152, 280]`, `:108` agent → `[280, 520]`) and keyboard
(`:88-95`, `:133-140`). They are written to `--sidebar-width` / `--agent-width`
on the app shell (`App.tsx:312-313`), which feed the canvas padding
(`canvas.css:31-32`). Nothing anywhere checks `sidebarWidth + agentWidth + gaps`
against the canvas/window width or reserves a pane floor. Worst cases at the
native `minWidth:760` (from report D's table):

| Scenario | Left pad | Right pad | Pane leftover | vs 360 min |
|---|---|---|---|---|
| Defaults (sb 196, agent 344) | 212 | 360 | **188px** | crushed |
| Both rails MAX (sb 280, agent 520) | 296 | 536 | **−72px** | content gone |
| Both rails MIN (sb 152, agent 280) | 168 | 296 | 296px | still < 360 |

Because `.outline-panel-surface` is `flex: var(--panel-size) 1 0; min-width:0`
(`canvas.css:72`) inside an `overflow:hidden` canvas (`canvas.css:24-25`), the
pane shrinks under its content with no scrollbar; the `--panel-content-x` gutters
(28px each side, `canvas.css:138`) then eat what's left and the reading column
collapses.

**Proposed fix.** Couple the rail widths to the live canvas width via a shared
clamp helper, applied at **both** ends:

1. **At drag/keyboard time** — clamp the rail being resized so that
   `thisRail ≤ canvasWidth − gaps − otherRail − panelFloor`, where `panelFloor`
   is `--outline-panel-min-width × paneCount` (read from the canvas, mirroring the
   existing `panelMinWidthPx()` helper at `useResizableLayout.ts:25-29`). The
   resize handlers already capture `canvasRef` (`:51`, used by the panel-pair
   resize at `:148`), so the canvas width is already in reach — extend
   `beginSidebarResize` (`:53`) and `beginAgentResize` (`:98`) and their keyboard
   twins to pass an upper bound into `clamp`, instead of the bare `MAX_*` constant.
2. **At window-resize time** — add a `window 'resize'` effect in the hook (none
   exists today; confirmed the only renderer resize listener is unrelated,
   `NodePanel.tsx:325`). On resize, if the current rails violate the floor, shrink
   them (which rail first is a deferred decision — see below), clamped to their own
   mins. This is what stops a 520px agent persisting into a 760px window.

The clamp must respect the rail's own min (never shrink a rail below `MIN_*`); if
even both rails at their mins can't free 360 for the pane (the 296 < 360 row
above), the deferred decision picks the loser (let the pane sit at 296, or also
raise the window `minWidth`). The shared helper keeps drag-time and resize-time
clamping identical so they can't disagree.

**Approach.** Pure hook change in `useResizableLayout.ts` + a one-line effect.
Add a `clampRailToWindow(width, otherRail, canvas)` helper; thread it through the
four entry points (sidebar drag/keyboard, agent drag/keyboard) and the new resize
effect. `paneCount` comes from `panels.length` (already a hook input, `:48`).
**(needs live resize smoke test — drag math + resize re-clamp.)**

### D2 — No re-clamp of rail widths on window `resize`

**Current behavior.** Covered structurally by D1's window-resize gap: the hook has
no `resize` listener (`useResizableLayout.ts` — verified absent), so rail state is
frozen at whatever the last drag set, regardless of how small the window later
gets. Report D row: `useResizableLayout.ts:49-50` (no window-resize effect).

**Proposed fix.** This is the second half of D1 (the `window 'resize'` effect).
Listed separately because it has its own failure mode and its own smoke-test
case (start wide with a fat agent, shrink the window, confirm the agent shrinks
rather than crushing the pane), but it shares the clamp helper and lands in the
same change as D1.

**Approach.** `useEffect` in `useResizableLayout.ts` registering a debounced (or
rAF-coalesced) `resize` handler that re-runs `clampRailToWindow` for both rails
and `setSidebarWidth` / `setAgentWidth` only when the clamp actually changes a
value (avoid render churn on every resize tick). Clean up the listener on unmount.
**(needs live resize smoke test.)**

### D3 — Multi-pane is gated on count, not available width

**Current behavior.** `openPanel` gates only on `panels.length >= MAX_PERSISTED_PANELS`
(`useWorkspaceLayout.ts:279`; same count gate for debug panes at `:318`,
persisted cap `MAX_PERSISTED_PANELS = 4` at `:13`, slice at `:92`). A second/third/
fourth pane is added regardless of whether the padded canvas can host even one
pane at its 360 floor, so 2–4 panes split an already-too-narrow leftover N ways.
The inter-pane *pair* resize does respect the floor within a pair
(`useResizableLayout.ts:161-163`), but nothing stops the pane from being *opened*
into a window too small to hold it.

**Proposed fix.** Add an available-width guard to the open/add path: a pane may be
added only if the resulting `paneCount × panelFloor` fits the canvas inner width
(canvas width − rail padding − gaps). When it doesn't fit, the cleanest options
(deferred decision): (a) refuse to add and surface why, (b) auto-collapse a rail
to make room, or (c) add but shrink rails via the D1 clamp. Given D1 already
couples rails to width, the least surprising behavior is (c)/(b): adding a pane
re-runs the D1 clamp so rails give up space first, and only refuse if even
collapsed rails + min rails can't host `paneCount` panes.

**Approach.** Expose the canvas-inner-width / floor math from the resize hook (or a
small shared `layoutMetrics` helper) and consult it in `openPanel`
(`useWorkspaceLayout.ts:273`) before the `length < MAX` branch (`:290`). Keep the
count cap as the hard ceiling; add the width gate as the soft one. This is the one
defect that may need a tiny piece of user-facing feedback if we choose to refuse
— escalate the copy/behavior choice (see Decisions deferred).
**(needs live resize smoke test — open 2–4 panes at 760.)**

### D4 — Uncapped outline indentation (`depth × 28px`)

**Current behavior.** `useOutlinerRowInteraction.ts:395`:
`const wrapStyle: CSSProperties = { marginLeft: depth * 28 };` — unbounded. At
depth 10 the indent alone is 280px; in a narrow (or crushed, per D1) pane the row
content column collapses to a sliver. Text still wraps (never clips), so it
degrades rather than breaks, but it becomes unusable. Report D row:
`useOutlinerRowInteraction.ts:395`.

**Proposed fix.** Clamp the effective indent. Two shapes (pick in Decisions
deferred): (a) hard cap — `Math.min(depth, MAX_INDENT) × 28`; or (b) graceful
step-down — full 28px per level up to some depth, then a reduced px/level past it
(keeps relative nesting legible deeper). A hard cap is simpler and matches the
report's first suggestion; the step-down preserves more depth signal. Either keeps
a usable content column.

**Approach.** One-line change at `useOutlinerRowInteraction.ts:395` using a module
constant (`MAX_INDENT_DEPTH`). No CSS change for the outliner itself. Mirror this
for the sidebar tree (D5). No live resize test strictly required (deterministic
from `depth`), but worth eyeballing a depth-8+ subtree in a 360 pane.

### D5 — Sidebar tree indentation is likewise uncapped (mirror of D4)

**Current behavior.** The sidebar tree row computes left padding as
`… + var(--tree-depth, 0) × var(--sidebar-tree-indent)` with `--tree-depth` set
straight from the node depth in `Sidebar.tsx:83`
(`style={{ '--tree-depth': depth }}`), consumed by `sidebar.css:261-265` (row
padding) and `:278` (chevron offset). Uncapped, so at the 152px rail floor a deep
node's label ellipsizes to "…". Report D row: `sidebar.css:261-266`,
`Sidebar.tsx:83`.

**Proposed fix.** Cap `--tree-depth` at the same `MAX_INDENT_DEPTH` constant used
in D4 when setting the style in `Sidebar.tsx:83` (`Math.min(depth, MAX_INDENT_DEPTH)`),
so the CSS math is unchanged but bounded. Keeping the cap in TSX (not CSS) reuses
the one shared constant and keeps the two indent systems consistent.

**Approach.** One-line change in `Sidebar.tsx:83`; share the `MAX_INDENT_DEPTH`
constant with D4 (a small shared module, e.g. `layoutConstants.ts`, or export from
the row-interaction module). No live resize test required.

### D6 — Inline tag-bar has no wrap/overflow on non-plain rows

**Current behavior.** `.tag-bar` is `display: inline-flex` with **no `flex-wrap`
and no overflow scroll** (`outliner.css:2101-2108`); badges are `flex: 0 0 auto`
(`:2117`). On **plain-text rows** the `<TagBar>` is portaled into the editor's
inline text slot so it wraps with the prose (good — `OutlinerItem.tsx:1629-1643`,
the `isPlainTextRow` branch). On **non-plain rows** (reference/field/etc.) and the
page-title toolbar the bar renders inline (`OutlinerItem.tsx:1644-1652`, the `else`
branch) and the fixed-width badges overflow horizontally. Report D row:
`outliner.css:2101-2108`; `OutlinerItem.tsx:1629-1649`.

**Proposed fix.** Give `.tag-bar` a wrap/overflow strategy. Simplest and most
native: add `flex-wrap: wrap` plus a small `row-gap` so multiple badges drop to a
second line instead of spilling. (Alternatives: an `overflow-x:auto` scroller, or
a "+N" overflow chip — heavier, deferred.) Because the plain-row case already
wraps via the portal, `flex-wrap: wrap` is harmless there and fixes the non-plain
/ title-toolbar case. Must verify wrap doesn't disturb the row's vertical rhythm
(badges are 20px; a wrapped second row should align cleanly).

**Approach.** CSS-only in `outliner.css:2101` (add `flex-wrap: wrap;` and a
`row-gap`). Verify against a non-plain row with 10+ tags and the page-title
toolbar with many tags. **(needs live smoke test — confirm wrap, not spill, and no
rhythm break.)**

### D7 — Breadcrumb collapse is count-based, not width-based

**Current behavior.** `buildPanelBreadcrumb` collapses only when the visible chain
has `> 3` levels (`panelBreadcrumb.ts:29`): it then shows `[first, …, last two]`
(`:33-37`). With exactly 2–3 long sibling titles it does **not** collapse, so all
visible segments shrink toward "…" (per-segment ellipsis, `breadcrumb.css:155-162`),
and the early ones can become bare "…" — the last (current-context) segment isn't
protected. There's no overflow spill (clipped by `.panel-breadcrumb overflow:hidden`,
`breadcrumb.css:110-123`), so it degrades rather than breaks. Report D row:
`panelBreadcrumb.ts:29-37`; `breadcrumb.css:110-123`.

**Proposed fix.** Make collapse width-aware. `buildPanelBreadcrumb` is a pure data
function (no DOM), so the cleanest split is: keep the pure count-based collapse as
the structural floor, and add a **rendering-side** width guard in the breadcrumb
component — measure the container and either (a) cap per-segment `max-width` so the
last segment always wins remaining space, or (b) collapse additional middle
segments when measured width overflows. Option (a) (a CSS/measure tweak that
guarantees the last segment a larger share) is the lighter touch and keeps the
pure function pure. The exact approach is a Decisions-deferred item because it
trades simplicity (CSS max-width rule) against correctness (true measure-driven
collapse).

**Approach.** Prefer CSS-first: in `breadcrumb.css` give the **last** segment a
larger/uncapped `min-width` share and the middle segments a tighter `max-width`,
so narrowing eats the middle first and the current context stays readable. Only if
that proves insufficient in the smoke test, add a `ResizeObserver`-driven collapse
in the breadcrumb component (reuse the `collapsed`/`hiddenNodes` shape
`buildPanelBreadcrumb` already returns, `panelBreadcrumb.ts:4-8`). **(needs live
smoke test — 3 long sibling titles in a narrow pane.)**

## Decisions deferred

Defaults are stated so the build can proceed without blocking; each is reversible
(a constant or a clamp branch) and noted in the PR per the escalate-don't-guess
rule. Escalate only the one user-facing behavior (the pane-add refusal copy).

1. **Rail-coupling strategy (D1/D2/D3).** *Default: shrink the agent rail first,
   then the sidebar, each only down to its own min; never below.* Rationale: the
   agent has the larger range (280–520) so it absorbs the most slack, and the
   reading pane (the user's primary surface) is the thing being protected. If even
   both rails at min can't free 360, *default: let the pane sit below 360 at the
   760 floor* (rather than raising the native `minWidth`) — the 296px leftover is
   degraded but legible, and raising `minWidth` is a heavier, separate call.
2. **Pane-add-at-narrow-width behavior (D3).** *Default: re-run the D1 clamp so
   rails give up space first; refuse to add only if even min rails can't host
   `paneCount × 360`.* If refusal is needed, the **copy/feedback** for "can't open
   a pane, window too narrow" is **user-facing and is escalated** before build
   (don't invent product copy).
3. **Indent cap value (D4/D5).** *Default: `MAX_INDENT_DEPTH = 12`* (12 × 28 =
   336px cap) as a hard `Math.min` cap, shared by the outliner and sidebar. Revisit
   to a step-down curve only if 12 levels still crushes a 360 pane in the smoke
   test.
4. **Tag-bar overflow strategy (D6).** *Default: `flex-wrap: wrap`* (drop to a
   second line). Escalate to a "+N" overflow chip only if wrapping proves visually
   noisy on the page-title toolbar.
5. **Breadcrumb width-aware approach (D7).** *Default: CSS-first* (protect the last
   segment via min/max-width shares); upgrade to a `ResizeObserver` measure-driven
   collapse only if the CSS rule can't keep the current segment readable with 3
   long siblings.

## Collision check

Ran the self-check: `gh pr list` (open claims) + scan `docs/TASKS.md` + grep the
intended files against open-PR scopes.

- **Files this plan will touch (product code):**
  `src/renderer/ui/useResizableLayout.ts` (D1/D2), `src/renderer/ui/useWorkspaceLayout.ts`
  (D3), `src/renderer/ui/outliner/useOutlinerRowInteraction.ts` (D4),
  `src/renderer/ui/Sidebar.tsx` (D5), `src/renderer/styles/outliner.css` (D6),
  `src/renderer/styles/breadcrumb.css` (D7), and a possible new small shared
  constant module (`layoutConstants.ts`). Optionally `App.tsx` only if the clamp
  needs the shell-style write to move (it shouldn't — the hook owns the state).
- **Roadmap boundary contract** (`ui-quality-roadmap.md`): this plan owns report D
  exclusively. None of its files appear in another plan's owned set — the cosmetic
  layers own `settings-*.css`, `controls.css`, `button`/`input` primitives,
  `context-menu` glass, list-row idiom. No overlap.
- **Infrastructure-ownership files:** none touched. We do **not** edit
  `src/core/commands.ts`/`types.ts`, build config, `AGENTS.md`, `docs/TASKS.md`,
  or `CHANGELOG.md` (main-agent-owned).
- **PR #118** (codex settings-macOS-clarity) is **merged**; this plan touches none
  of its files (`useResizableLayout` / `useWorkspaceLayout` /
  `useOutlinerRowInteraction` / `Sidebar.tsx` / `outliner.css` / `breadcrumb.css`)
  — no overlap, no gate.
- **Action at plan time:** re-run `gh pr list` and grep these exact files against
  open-PR scopes immediately before opening the Draft PR; report "no overlap" or
  the specific conflict. (Snapshot at draft time: no sibling PR claims these
  resize/layout hooks.)

## Risks

- **Resize/drag math is touchy.** D1/D2/D3 change live drag and `resize`-handler
  math; an off-by-one or a wrong clamp bound can make a rail un-draggable, jump,
  or fight the window resize. **Mitigation:** one shared clamp helper used by both
  drag-time and resize-time so they can't disagree; live smoke test is mandatory,
  not optional.
- **Render churn on resize.** A naive `resize` listener that `setState` every tick
  re-renders the whole shell. **Mitigation:** rAF-coalesce, and only `setState`
  when the clamp actually changes a value.
- **Wrapping the tag-bar (D6) could disturb row rhythm** on non-plain rows.
  **Mitigation:** verify the 20px badge height + `row-gap` aligns; this is exactly
  the kind of thing the smoke test catches.
- **Breadcrumb width logic (D7) risks over-collapsing** (hiding context that fits).
  **Mitigation:** CSS-first default keeps all segments present, only re-shares
  width; the measure-driven path is the fallback, not the default.
- **Don't regress the things report D flagged as RIGHT:** rail collapse is
  transform+opacity only (no reflow); plain-row tags portal into the editor slot;
  the pane reading column is capped at 720 for wide windows. None of these fixes
  should touch those paths — verify in the smoke test that collapsing a rail and a
  wide window both still behave.
- **A11y:** the indent cap (D4/D5) must not change keyboard nav or the visual depth
  cue enough to mislead; cap is generous (depth 12) so deep structure stays
  distinguishable.

## Checklist

- [ ] **D1** — shared `clampRailToWindow` helper; thread through sidebar+agent
  drag (`useResizableLayout.ts:63,108`) and keyboard (`:88-95,133-140`) clamps;
  reserve `panelFloor = panelMin × paneCount`.
- [ ] **D2** — rAF-coalesced `window 'resize'` effect in `useResizableLayout.ts`;
  re-clamp both rails, `setState` only on change, cleanup on unmount.
- [ ] **D3** — available-width gate in `openPanel` (`useWorkspaceLayout.ts:279`,
  `:318`); keep the count cap as hard ceiling; escalate any refusal copy.
- [ ] **D4** — cap outline indent at `MAX_INDENT_DEPTH` in
  `useOutlinerRowInteraction.ts:395`.
- [ ] **D5** — mirror the cap on `--tree-depth` in `Sidebar.tsx:83`; share the
  constant with D4.
- [ ] **D6** — `flex-wrap: wrap` + `row-gap` on `.tag-bar` (`outliner.css:2101`);
  confirm plain-row portal path unaffected.
- [ ] **D7** — width-aware breadcrumb: CSS last-segment width share in
  `breadcrumb.css` (fallback: `ResizeObserver` collapse in the breadcrumb
  component).
- [ ] `bun run typecheck` + `bun run test:renderer` (and `test:core` if a shared
  constant module moves anything) green.
- [ ] **Live resize smoke test (mandatory — `dev:cc-2`).** Drive the window from
  760 up to wide and back, asserting at each step: (a) both rails at MAX → pane
  never crushes below 360; (b) shrink window with a fat agent → agent shrinks, no
  crush, **no horizontal scrollbar ever appears**; (c) open 1→4 panes at 760 →
  gate behaves; (d) depth-8–12 outline in a ~360 pane → content legible; (e) a
  non-plain row + page-title toolbar with 10+ tags → wraps, no spill; (f) 3 long
  sibling breadcrumb titles in a narrow pane → last segment stays readable; (g)
  regression: rail collapse, plain-row tag portal, and a wide window all still
  behave. Capture light + dark.
- [ ] Update `docs/spec/` for the responsive/resize behavior in the SAME change
  (A6); fold this Design into the relevant spec doc when shipped, flip status to
  `done`, move to `docs/plans/archive/`.
