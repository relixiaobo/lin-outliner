# Feedback states — `<EmptyState>` / `<ErrorState>` primitives + outliner empty states

Layer 2 (primitives + feature gaps) of the UI-quality roadmap
(`docs/plans/ui-quality-roadmap.md`). Source report:
`tmp/ui-review/B-states-empty-loading-error.md`.

The app has **three to four parallel, unreconciled idioms** for empty / loading /
error, each invented locally, with no shared primitive:

1. **Agent transcript family** — the most complete. Empty = text greeting OR
   onboarding (text + CTA, no icon); loading = animated capsule or `LoaderIcon`
   spinner; error = `WarningIcon` + text on a tinted `--danger` panel. The
   subagent transcript panel
   (`src/renderer/ui/agent/AgentSubagentDetailsPanel.tsx:309-331`) is the single
   best example: not-available / loading-spinner / error-with-retry / empty in
   one component.
2. **Settings-sheet family** (provider config + OAuth) — its own dialect.
   Loading = `LoaderIcon`; result = `settings-sheet-result is-{status}` with
   **`✓` / `✗` text glyphs** (not `WarningIcon`); list-level loading/empty =
   `agent-settings-empty` (bare centered text, no icon, no spinner).
3. **Outliner / workspace family** — almost no explicit states. Empty document,
   empty children, **empty search results**, **empty Trash**, and **empty
   Recents** all render the same way: a blank outline (a trailing draft line, or
   nothing). There is **no "no results", "trash is empty", or "nothing here"
   anywhere** in the outliner — a query that matches nothing is indistinguishable
   from a still-loading pane.
4. **App shell** — startup loading is text-only ("Loading…"); the global error is
   a bottom-right **toast** (`src/renderer/styles/toast-error.css:1`). That toast
   is the *only* toast in the app; every other error is inline, so error
   placement is split toast-vs-inline.

The one shared empty primitive that exists, `PopoverEmpty`
(`src/renderer/ui/outliner/PopoverList.tsx:91`, css `popover-command.css:159`),
is reused consistently by the in-editor pickers — a good model nothing else
follows.

This plan introduces the two missing primitives, fills the outliner gap, sets a
loading/skeleton policy, and unifies error iconography/placement.

## Goal

1. Ship a shared **`<EmptyState>`** (icon slot + title + optional body + optional
   CTA) and **`<ErrorState>`** (`WarningIcon` + message + optional retry) and
   migrate the text-only empty/error families through them, collapsing the 4–5
   bespoke CSS class families into one structural component (`PopoverEmpty` stays
   as the popover-scoped wrapper, re-expressed on the same primitive).
2. Add the **missing outliner empty states** — empty search results, empty Trash,
   empty Recents, empty document — so a blank pane reads as "nothing here", not
   "still loading".
3. Set a **loading/skeleton policy** (A9 perceived responsiveness): decide
   per-surface between spinner / skeleton / nothing, and replace the worst
   offenders (the `null` flash, the no-spinner muted cards).
4. **Unify error treatment**: one icon (`WarningIcon`), retire the `✗`/`✓` glyphs
   and the icon-less variants; make toast-vs-inline a deliberate, documented split.
5. Surface **aborted agent turns** with a neutral "Stopped" marker so hitting Stop
   has visible feedback.

## Non-goals

- The **dead "Pinned" sidebar section** (`pinnedNodeIds` is a literal `[]` at
  `src/renderer/ui/Sidebar.tsx:57`, so `sidebar-empty-row` at `Sidebar.tsx:151-155`
  is shown forever). Wiring or removing it is owned by
  `docs/plans/sidebar-pinned-nodes.md` — **cross-reference only**. This plan does
  not touch `Sidebar.tsx:57` or the pin feature; if/when that plan removes the
  section, the `sidebar-empty-row` migration row below becomes moot and is dropped.
- All **text-input / select / textarea / placeholder / disabled-field** styling —
  owned by `input-primitive.md`.
- Button shape/fill/size (incl. the onboarding CTA button and subagent retry
  button chrome) — owned by `button-primitive.md`. This plan consumes `<Button>`
  for CTAs but does not restyle it.
- Accent-focus, overlay radius, context-menu glass, list-row idiom, token sweep —
  owned by `design-system-consistency.md` / `composition-rhythm.md`.
- The full **`settings-*.css` migration** — was gated behind PR #118 (now MERGED;
  see Collision check). The settings-pane empty/error migrations are unblocked and
  land on top of post-#118 `AgentSettingsView.tsx`.
- **Image-row loading placeholder** (`ImageRow.tsx:63-68`, native lazy decode
  reflow) — noted in the report but deferred; it is a layout/decode concern, not
  an empty/error idiom. Tracked in "Decisions deferred".
- A toast **system** (queue, stacking, auto-dismiss policy). We keep the single
  existing shell toast as-is; this plan only documents the toast-vs-inline rule.

## Design

### 1. The `<EmptyState>` / `<ErrorState>` primitive API

New file `src/renderer/ui/primitives/FeedbackState.tsx` (sits beside
`ButtonControl.tsx`, `ResizeHandle.tsx`). One small CSS file
`src/renderer/styles/feedback-state.css` holding `.feedback-state` (+ modifiers),
replacing the five families' shared structure (they currently duplicate
`display:flex; center; gap; color: --text-faint; font-size: --font-meta`, e.g.
`agent-subagent.css:290-299`).

```tsx
type FeedbackVariant = 'empty' | 'error';

interface EmptyStateProps {
  icon?: ComponentType<{ size?: number; className?: string }>; // optional icon slot
  title: ReactNode;          // primary line (required)
  body?: ReactNode;          // optional secondary line
  action?: ReactNode;        // optional CTA (a <Button>) — owned by button-primitive
  size?: 'inline' | 'panel'; // 'inline' = popover/list density; 'panel' = centered min-height
  className?: string;
  role?: 'status';           // loading/transient empties announce; static do not
}

interface ErrorStateProps {
  message: ReactNode;        // the error text
  onRetry?: () => void;      // when present, renders a Retry <Button>
  retryLabel?: ReactNode;    // default localized "Retry"
  size?: 'inline' | 'panel';
  className?: string;
}
```

- `<ErrorState>` always renders `WarningIcon` (`src/renderer/ui/icons.ts:16`,
  `AlertTriangle as WarningIcon`) and tints with `--danger`. It is `EmptyState`
  with a fixed icon + `is-error` modifier; implement `ErrorState` on top of
  `EmptyState` so there is exactly one layout.
- `role="status"` is opt-in (loading/transient empties set it; static "no results"
  do not, to avoid SR spam) — preserves the existing `role=status` on the chat
  error banner (`AgentChatPanel.tsx:1058-1062`) and OAuth waiting
  (`ProviderOAuthForm.tsx:291-296`).
- `PopoverEmpty` (`PopoverList.tsx:91`) is re-expressed as
  `<EmptyState size="inline">` under the hood so the in-editor pickers keep their
  exact density; its public signature (`children`) is preserved so the ~6 call
  sites don't change.
- **CTA/retry buttons are `<Button>`** from `button-primitive.md` (not restyled
  here). If `button-primitive` hasn't landed, use the existing `ButtonControl`
  and leave a `// TODO(button-primitive)` — do not invent a new button.

**Migration map** (text-only empties → `<EmptyState>`; errors → `<ErrorState>`).
#118 is merged, so the settings rows are unblocked (rebase on `main`; #118 reshaped
`AgentSettingsView.tsx`, so re-verify the cited lines).

| Call site (file:line) | Current class | Migrate to | Gate |
|---|---|---|---|
| `AgentSubagentDetailsPanel.tsx:310` | `agent-subagent-empty` | `<EmptyState size="panel">` | — |
| `AgentSubagentDetailsPanel.tsx:312-318` | `agent-subagent-empty` + `LoaderIcon` | `<EmptyState role=status icon=Loader>` (loading) | — |
| `AgentSubagentDetailsPanel.tsx:320-327` | `agent-subagent-empty is-error` + retry | `<ErrorState onRetry>` | — |
| `AgentSubagentDetailsPanel.tsx:329-330` | `agent-subagent-empty` | `<EmptyState size="panel">` | — |
| `AgentChatPanel.tsx:964-967` | `agent-conversation-empty` (loading / "No conversations") | `<EmptyState>` (+`role=status` on loading) | — |
| `AgentChatPanel.tsx:1058-1062` | `agent-message-error` (chat banner) | keep `AgentMessageError`; align icon only | — |
| `AgentDebugPanel.tsx:309-318` | `agent-debug-empty` | `<EmptyState>` | — |
| `AgentDebugPanel.tsx:341` (`agent-debug-error`, css `agent-debug.css:621`) | text, **no icon** | `<ErrorState>` (adds `WarningIcon`) | — |
| `launcher/LauncherApp.tsx:236` | `launcher-empty` (css `launcher.css:239`) | `<EmptyState size="inline">` | — |
| `PopoverList.tsx:91` (`popover-empty`, css `popover-command.css:159`) | shared empty | re-express on `<EmptyState size="inline">` | — |
| `AgentSettingsView.tsx:642,834,836,871,940,946,948` | `agent-settings-empty` (css `settings-fields.css:210`) | `<EmptyState>` | **after #118** |
| `AgentSettingsView.tsx:970-974` (#118-new) | `agent-settings-alert` (`WarningIcon` + `role="alert"`) | already canonical (`WarningIcon`) — leave, or fold into `<ErrorState>` candidate | **after #118** |
| `ProviderConfigForm.tsx:276-279` | `settings-sheet-result` `✓`/`✗` glyph | success → `CheckIcon`; error → `<ErrorState>` | **after #118** |
| `ProviderOAuthForm.tsx:310-314` | `settings-sheet-result` `✗` glyph | `<ErrorState>` | **after #118** |
| `ProviderConfigWindow.tsx:61,68` | `agent-settings-empty` (text error/loading) | `<ErrorState>` / `<EmptyState>` | **after #118** |
| `Sidebar.tsx:151-155` (`sidebar-empty-row`, css `sidebar.css:176`) | icon+text | **n/a — owned by `sidebar-pinned-nodes.md`** | excluded |

Old class families are deleted as their last call site migrates; leave a one-line
comment in the CSS file pointing at `feedback-state.css` for any that linger
behind the #118 gate.

### 2. Outliner empty states to add (with copy)

The outliner renders blank when a node has no children. The render path is
`OutlinerView.tsx:49-75`: `builtRows` is empty, and depending on `trailingDraft`
mode either a single draft line is appended (`OutlinerView.tsx:69-75`) or nothing.
The four cases below need a distinct empty-state element rendered *instead of /
above* the blank rows, keyed off the panel's root node type.

Search results live behind `OutlinerView.tsx:77-82` (the `parent?.type ===
'search'` effect that refreshes `refreshSearchNodeResults`); when that returns no
children the pane is blank. Trash is a system node whose header icon resolves in
`NodePanel.tsx` (`projection.trashId` at `NodePanel.tsx:257`); `renderHeaderIcon`
only branches on libraryId / schemaId / trashId / searchesId (+ `type ===
'search'`) — there is **no `recentsId` branch**. Recents is itself configured as a
`type === 'search'` node (`core.ts:2354`) and its id is resolved in
`Sidebar.tsx:46`, **not** in `NodePanel.tsx`. **Because Recents is a search-type
node, its empty state overlaps the Search "no results" case — reconcile the two**
(a Recents pane with no children is structurally the same blank-search pane, so do
not invent a separate Recents-only path that diverges from search's loading/empty
handling).

| Surface | Trigger | Icon | Title (copy) | Body (copy) | CTA |
|---|---|---|---|---|---|
| Search — no results | `parent.type === 'search'` AND `builtRows.length === 0` after refresh settles | `SearchIcon` (`icons.ts:83`) | "No results" | "No nodes match this search." | — |
| Trash empty | root is `projection.trashId` AND no children | `TrashIcon` (`icons.ts:93`) | "Trash is empty" | "Deleted nodes will appear here." | — |
| Recents empty | root is `projection.recentsId` (a `type === 'search'` node, so it also matches the Search row — reconcile, see above) AND no children | `RecentsIcon` (`icons.ts:28`) | "No recent nodes" | "Nodes you open will show up here." | — |
| Document empty (generic) | regular node, no children, not search/trash/recents | `FileTextIcon` (`icons.ts:44`) | "Empty" | "Press Enter to add your first node." | — |

- **Distinguishing empty from loading is the whole point.** Search must only show
  "No results" **after** the `refreshSearchNodeResults` effect resolves
  (`OutlinerView.tsx:79`) — while in-flight, show nothing or a spinner per the
  loading policy (§3), never "No results" on a query that is still running. This
  needs the search node's loading flag threaded into `OutlinerView`; if no such
  flag exists, that is an Open Question (see Decisions deferred — search loading
  signal).
- The empty state must **not** suppress the trailing draft for the document case:
  for an editable empty document the user can just type, so "Empty / press Enter"
  is a hint layered with the draft line, not a replacement. For read-only system
  panes (Trash/Recents/search results) there is no draft line, so the empty state
  is the sole content.
- Copy lands in `src/core/i18n/messages/en.ts` (and the other locale files) under
  a new `outliner.empty.*` namespace; all five+ locales must be updated (i18n
  rule). Exact final wording is a reversible local — the table is the starting
  point.

### 3. Loading / skeleton policy

Today every load is a spinner (`LoaderIcon`), bare "Loading…" text, or nothing —
no skeletons. Policy (A9: perception over benchmarks; measure before trading):

| Class of load | Policy | Rationale |
|---|---|---|
| Fast, in-place (settings panes, session list, subagent transcript) | **spinner** via `<EmptyState role=status icon=Loader>` | already sub-second; a skeleton would flash |
| First paint of a list whose shape is known (session list, settings lists) | **optional skeleton** — deferred default (see below) | reads as loading, not broken; only if it measurably helps |
| Transient empties that may resolve (`!settingsLoaded`) | **never `null`** | `AgentChatPanel.tsx:1066` renders `null` → blank flash that reads as broken; replace with `<EmptyState role=status>` spinner |
| Muted no-spinner cards (`AgentDebugPanel.tsx:340`, "loading runtime") | **add spinner** | adjacent tool-call pending shows a spinner; debug disagrees |
| Outliner search results in flight | **spinner or nothing, never the empty state** | see §2 — empty must mean empty |

Hard rules:
- **No `null` returns for a loading state.** Replace every "render nothing while
  loading" with a `role="status"` `<EmptyState>` so first paint reads as loading.
- A skeleton, if added, must honor `prefers-reduced-motion` (no shimmer) and use
  neutral `--fill-*` tokens (B3) — never a brand accent shimmer.
- **Measure before adding skeletons** (A9): use the existing apply/latency probe;
  only introduce a skeleton where a spinner demonstrably under-reads. Default for
  this plan leans spinner-first (skeletons deferred — see below).

### 4. Error unification

Two axes are split: **iconography** (three ways) and **placement** (toast vs
inline).

**Iconography — converge on `WarningIcon`** (`icons.ts:16`):

| Surface | file:line | Current | Target |
|---|---|---|---|
| Agent message error | `AgentMessageRow.tsx:560`, css `agent-tool-rows.css:214` | `WarningIcon` | keep (canonical) |
| Subagent transcript error | `AgentSubagentDetailsPanel.tsx:320-327` | `WarningIcon` + retry | `<ErrorState onRetry>` |
| Chat error banner | `AgentChatPanel.tsx:1058-1062` | `WarningIcon`, `role=status` | keep; route through `<ErrorState>` |
| Settings pane-level error (#118-new) | `AgentSettingsView.tsx:970-974` | `WarningIcon` + `role="alert"` | already canonical — keep, or `<ErrorState>` candidate (after #118) |
| Provider config validate error | `ProviderConfigForm.tsx:279` | **`✗` glyph** | `WarningIcon` via `<ErrorState>` (after #118) |
| OAuth error | `ProviderOAuthForm.tsx:310-314` | **`✗` glyph** | `WarningIcon` via `<ErrorState>` (after #118) |
| Debug runtime error | `AgentDebugPanel.tsx:341`, css `agent-debug.css:621` | **no icon** | add `WarningIcon` via `<ErrorState>` |
| Provider-config-window load error | `ProviderConfigWindow.tsx:61` | **no icon** | `<ErrorState>` (after #118) |
| Tool-call error badge | `AgentToolCallBlock.tsx:311,644`, css `agent-tool-rows.css:236` | `errorBadge` text "error" | leave as badge (in-row chip, different scale) — note only |

Success glyphs: the `✓` in `ProviderConfigForm.tsx:276-277` becomes `CheckIcon`
(matching OAuth-connected `CheckIcon` at `ProviderOAuthForm.tsx:244-253`) — done
in the same #118-gated wave.

**Placement — document the rule, don't re-architect:**
- **Toast** (the single bottom-right `.error`, `App.tsx:415-422`,
  `toast-error.css:1`) stays **only** for transient *command-level / app-shell*
  errors (a fired command that failed, with nowhere local to show it).
- **Inline `<ErrorState>`** for every *surface-local* error (a panel that failed
  to load its own content). This is already the de-facto pattern; the plan just
  ratifies it so a reader can predict where an error appears. No second toast is
  introduced.

### 5. Aborted agent turns ("Stopped" marker)

`isError` deliberately excludes `stopReason === 'aborted'`
(`AgentMessageRow.tsx:216`, `:241`, `:534` — `hasError = !!message.errorMessage
&& message.stopReason !== 'aborted'`), so an aborted turn renders its partial
content silently with no acknowledgement. Add a **neutral** "Stopped" marker
(not an error — B4: status colors carry status meaning only; this is neutral
`--text-soft`, not `--danger`):

- Detect `message.stopReason === 'aborted'` in the assistant render path
  (`AgentMessageRow.tsx:557-562`), and when true append a small neutral row
  ("Stopped" + optional `StopCircle`/`XCircle` icon) after `assistantBlocks`,
  beside `AgentStreamingIndicator`'s slot (which only shows while `turnActive`, so
  they never coexist).
- It is **not** an `<ErrorState>` (no `WarningIcon`, no `--danger`); it is a
  distinct neutral marker — possibly a tiny dedicated element rather than
  `EmptyState`. Whether it lives in `EmptyState` or its own micro-component is a
  reversible local.
- Copy: `agent.message.stopped` → "Stopped" (all locales).
- Whether to add this at all is flagged below (Decisions deferred) — it changes
  visible agent behavior, so it is escalation-worthy if there is product doubt.

## Decisions deferred

Reversible locals decided in-build are *not* listed here; these are the
directional calls to confirm with the PM (escalate-don't-guess):

1. **Skeletons vs spinners — default.** Proposed default: **spinner-first**, add
   skeletons only where a measured spinner under-reads (A9). Confirm we are not
   committing to a skeleton system in this plan. *(Lean: spinner-first.)*
2. **Which surfaces get empty states first.** Proposed first cut: **search "no
   results" + Trash empty** (the two genuinely ambiguous-against-loading cases),
   then Recents, then generic empty document. Confirm the cut and whether the
   generic empty-document hint is wanted at all (it competes with the existing
   draft-line affordance). *(Lean: search + Trash first.)*
3. **"Stopped" marker — add it?** It changes visible agent transcript behavior.
   Proposed: yes, neutral marker. Confirm copy ("Stopped" vs "Cancelled") and
   that a neutral (non-error) treatment is right. *(Lean: yes, "Stopped",
   neutral.)*
4. **Search loading signal.** Surfacing "No results" correctly needs an in-flight
   flag for `refreshSearchNodeResults` (`OutlinerView.tsx:77-82`). If none exists,
   adding one touches the search result plumbing — confirm scope or fall back to
   "show nothing while the effect's promise is unsettled, empty state only after".
5. **`ImageRow` placeholder box** (`ImageRow.tsx:63-68`) — deferred out of this
   plan; confirm it belongs to a follow-up (layout/decode), not here.
6. **Toast policy** — confirm we keep exactly one shell toast and never add a
   second; everything else inline.

## Collision check

- **PR #118** ([codex] Settings macOS clarity pass, `codex/settings-macos-clarity`)
  is now **MERGED**. It owned `settings-*.css`, `controls.css`, `design-system.md`,
  and rewrote `AgentSettingsView.tsx`. It kept `agent-settings-empty` as the
  settings empty idiom and added the `agent-settings-alert` (`WarningIcon` +
  `role="alert"`) pane-level error — it did **not** introduce an
  `EmptyState`/`ErrorState` primitive, so this plan's premise still holds. The
  settings-pane empty/error migrations (`agent-settings-empty` in
  `settings-fields.css:210`, the `✓`/`✗` `settings-sheet-result` glyphs in
  `ProviderConfigForm.tsx` / `ProviderOAuthForm.tsx`) were gated **after #118** and
  are now unblocked; line numbers in the migration map reflect post-#118
  `AgentSettingsView.tsx`. The new-primitive + outliner-empty + abort-marker work
  has **no overlap** with #118.
- `docs/plans/sidebar-pinned-nodes.md` — owns the dead "Pinned" section
  (`Sidebar.tsx:57`). **No overlap:** this plan excludes `sidebar-empty-row` and
  cross-references it only.
- `button-primitive.md` / `input-primitive.md` — share files in `src/renderer/ui`
  but **not** the same lines: CTAs/retry buttons here *consume* `<Button>`, and
  this plan touches none of the input/select/textarea styling. Sequence the CTA
  rows behind `button-primitive` landing (or use `ButtonControl` interim with a
  TODO).
- No open PR currently touches `OutlinerView.tsx`, `NodePanel.tsx`,
  `AgentSubagentDetailsPanel.tsx`, `AgentMessageRow.tsx`, `AgentDebugPanel.tsx`,
  or `PopoverList.tsx`. New files (`primitives/FeedbackState.tsx`,
  `styles/feedback-state.css`) collide with nothing.

## Risks

- **Density regressions on migration.** The five families have subtly different
  paddings / min-heights (e.g. `agent-subagent-empty` `min-height:140px` at
  `agent-subagent.css:292` vs `popover-empty` inline density). The `size`
  prop must reproduce each; visual-verify light + dark before deleting old CSS
  (B11 — don't relax guards; fix CSS to tokens).
- **"No results" false-positive while loading** (the report's core ambiguity).
  If the search loading signal is wrong, the empty state flashes on every keystroke
  — worse than blank. Gate strictly on the resolved effect (Open Question 4).
- **i18n surface.** New copy (`outliner.empty.*`, `agent.message.stopped`,
  retry/loading labels) must land in **all** locale files or typecheck fails — the
  typed i18n catches missing keys, so this is a hard gate, not a soft risk.
- **Abort-marker placement vs streaming indicator.** Must not render the "Stopped"
  marker while `turnActive` (`AgentMessageRow.tsx:562`) — verify the two states
  are mutually exclusive in the data, not just usually.
- **#118 race.** If the settings rows are touched before #118 merges, a rebase
  conflict on `settings-fields.css` / `ProviderConfigForm.tsx` is near-certain —
  honor the gate.
- **Guard tests** may assert on the old class names (`agent-settings-empty`,
  `popover-empty`, etc.); update guards in the same change, don't relax them (B11).

## Checklist

**Execution (complete-per-PR).** Shape (b): Phase A (the `<EmptyState>` /
`<ErrorState>` primitive **plus** its core consumer migrations — popover, subagent
panel, session list, debug panel, launcher) is a complete feature and the
foundation the rest build on (A7). Phases B–E are **independent complete
improvements**, each its own PR, each visibly verifiable on its own (B outliner
empty states, C loading policy, D error unification, E aborted-turn marker); they
depend only on A's primitive. No PR ships the primitive alone or a half-migrated
surface.

Phase A — primitive (no #118 dependency):
- [ ] `src/renderer/ui/primitives/FeedbackState.tsx` — `<EmptyState>` +
  `<ErrorState>` per §1 API.
- [ ] `src/renderer/styles/feedback-state.css` — `.feedback-state` + `is-error` +
  `inline`/`panel` sizes, token-only (B1/B3).
- [ ] Re-express `PopoverEmpty` (`PopoverList.tsx:91`) on `<EmptyState
  size="inline">`, signature unchanged.
- [ ] Migrate subagent panel (`AgentSubagentDetailsPanel.tsx:310-330`), session
  list (`AgentChatPanel.tsx:964-967`), debug panel
  (`AgentDebugPanel.tsx:309-318,341`), launcher (`LauncherApp.tsx:236`).
- [ ] Delete migrated CSS families; point a comment at `feedback-state.css` for
  each migrated family.

Phase B — outliner empty states:
- [ ] Thread root-type + search-loading signal into `OutlinerView.tsx:49-82`.
- [ ] Render search-no-results / Trash / Recents / empty-document empty states (§2).
- [ ] Add `outliner.empty.*` copy to **all** locale files.

Phase C — loading policy:
- [ ] Replace `null`-while-loading (`AgentChatPanel.tsx:1066`) with `role=status`
  `<EmptyState>`.
- [ ] Add spinner to muted no-spinner load card (`AgentDebugPanel.tsx:340`).
- [ ] (deferred) skeletons only if measured — see Decisions deferred 1.

Phase D — error unification:
- [ ] Route debug runtime error (`AgentDebugPanel.tsx:341`) through `<ErrorState>`
  (adds `WarningIcon`).
- [ ] Settings/provider/OAuth glyph→icon rows **after #118** (migration map).
- [ ] Document toast-vs-inline rule in `docs/spec/` (see A6 — spec in same change).

Phase E — aborted turns:
- [ ] Neutral "Stopped" marker in `AgentMessageRow.tsx:557-562` on
  `stopReason === 'aborted'`; `agent.message.stopped` copy in all locales.

Cross-cutting:
- [ ] `bun run typecheck` + `test:renderer` + relevant guard tests.
- [ ] Visual verification light + dark (B-review parity).
- [ ] Fold the §1–§5 design into the relevant `docs/spec/` doc; flip status as it
  ships.
