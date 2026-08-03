# Unified Command Surface

## Goal

**One action registry** behind every surface that acts on an outline node, and
**one retrieval implementation** behind every surface that finds a node.

- The node context menu becomes a *filtered, anchored view* of the registry.
- The command surface becomes the registry's *searchable view* — and the only
  one summoned by a hotkey, in-app and out-of-app alike.
- Everything the context menu can do, the command surface can do. The context
  menu is a **subset**, never a second implementation.

The user-visible promise: **one action, one habit.** Multiple entry points are
fine; multiple implementations are not.

## Positioning (why this shape)

`README.md`: Tenon "uses an outliner-shaped interface, but the product is aimed
at structuring context, directing local agents, and keeping work inspectable."
The outline is the substrate, not the point. Two consequences drive this plan:

1. **Captured material earns its keep by being findable and agent-readable**, not
   by looking rich. Hence no destination picker, no embed cards, no rich extraction
   here — capture lands in Today with an optional user tag, and can be handed to
   the agent panel.
2. **Actions are the product surface**, so they need one catalog. A verb that
   exists only in a right-click menu is invisible to the keyboard and to search.

**What this delivers, stated honestly.** The registry's payoff is mostly
*optionality*, not present-day speed: once it exists, every action added later gets
a keyboard path, search, and a reviewed bilingual name for free. Only three things
here are immediately felt — retrieval convergence (the context menu's *Move to* can
currently fail to show a target at all), capture confirmation, and asking the agent
about a page from outside the app. Everything else is reachability at the margin
and groundwork whose value arrives later. The daily writing loop does not get
faster; that belongs to `performance-optimization.md`. Judge the result against
that claim, not a broader one.

The evidence behind both, and the boundary against the product this surface was
modelled on, are in the appendix — they are provenance, not design, and a builder
does not need them to build.

## Non-goals

- **No habit-adaptive default action.** The default highlight is a fixed rule.
  Personalization already exists where it belongs: search *ordering*
  (`nodeAccessStore`). It never moves what Enter does.
- **No Inbox and no capture-destination picker.** Today's date node is the
  chronological inbox; a second bucket contradicts the standing no-special-buckets
  stance (cf. `floating-toolbar-polish.md` → *Destination policy*).
- **No screenshot-as-context.** It serves a general desktop-assistant need, off
  this product's line, and would pull in a Screen Recording (TCC) grant plus a
  dependency on the unapproved `agent-computer-control.md`.
- **No rich page extraction here, and no provider-breadth work.** Rich extraction
  lands as a main-process static URL reader (`file-preview.md`) plugged into the
  existing `PageContentExtractor` seam; this plan neither builds nor blocks it, and
  the capture loop (D9) works with or without it. Provider breadth stays in
  `launcher-provider-expansion.md`. **No browser extension is built by anyone** —
  `browser-extension-integration.md` is a historical filename for a plan whose own
  non-goals exclude extensions.
- **No embed rendering.** The `embedType`/`embedId` schema removal is its own
  change (`embed-strategy.md`).
- **No positional-trigger rewrite.** `/`, `@`, `#` are *at-caret* insertion and
  stay separate and disjoint from the registry.
- **Non-node context menus stay out of the registry** — the sidebar row menu,
  Thread item menu, inline-file menu, and field-row menu act on things that are
  not outline nodes. Folding them in would turn the command surface into a
  junk drawer and destroy its searchability.
- **No AI runtime work.** "Send to the agent panel" reuses the shipped
  `agent/agentReveal.ts` handoff.

## Design

### D1 — The registry is shared code, evaluated where the document is

This is the load-bearing decision. The command surface's out-of-app view runs in
the **locked-down launcher renderer, which has no document** (`spec/launcher.md`:
it resolves search hits over IPC precisely because it cannot read the projection).
So a registry that lives in renderer state cannot serve both views directly.

Note what does *not* move: **actions already execute in main.** The renderer's
context menu calls `api.moveNode(...)` over IPC and Core applies it. Only
*applicability* is renderer-bound today, because the predicates are typed against
the renderer's `DocumentIndex`. Main holds the document (`documentService.ts`), so
main can evaluate them once they are shared code.

**So the registry and its predicates live in `src/core/`**, evaluated against
`DocumentProjection` wherever a projection is at hand, and both views render what
they are given. The migration cost of the predicates is measured by the stage-0
spike (open question 1), which also names the contingency if it proves expensive —
a cost question, not a second design.

Registry entry shape:

```ts
interface ActionDefinition {
  id: ActionId;                                     // stable, i18n-independent
  scope: 'node' | 'selection' | 'panel' | 'app';    // which views may show it (D2, layer 1)
  operands(ctx: ActionContext): readonly NodeId[];  // what it would act on; empty = N/A
  parameter?: ParameterSpec;                        // a second step, when one is needed
  effect(operands, parameter): Effect;              // a serializable instruction
}
```

Three deliberate choices, each of which the obvious shape gets wrong:

**`operands()` returns a list, never a boolean.** "Not applicable" is the empty
list. The existing predicates already return id lists — `idsAllowedForMoveTo`,
`idsAllowedForDuplicate`, `idsEnabledForSelectionAction`,
`idsAllowedForStructuralBatch/IndentBatch/OutdentBatch`, `planSelectionDelete`,
plus `trashActions.ts`, `nodeLocation.isNodeInTrash`, and
`contextMenuSelection.resolveActiveNodeSelection` — because an action often
applies to *part* of a selection. A `boolean | NodeId[]` union would throw that
away and force every caller to re-derive the subset.

**`parameter` is what makes half the action set expressible at all.** *Move to*
needs a destination, *Add tag* needs a tag: they are two-step actions, and a
registry that only carries "what to run" cannot describe them. A parameter's
candidates come from the one retrieval service (D5) or the one tag selector, so
**the *Move to* picker converges onto shared ranking by construction** — not by
someone remembering to fix it. The plan's most visible defect and its central
abstraction close each other.

**`effect` is data, not a closure.** Actions do three different things: mutate
(a core command, A4), navigate (`navigateRoot` + `focusNode`), and hand off (the
`agentReveal` composer staging). A `command: CoreCommandRef` field can only
express the first, and a callback cannot cross a process boundary. As a
serializable instruction, the effect is produced wherever applicability is
evaluated and performed by whoever owns it — main runs commands, the main renderer
runs navigation and the handoff, and the panel performs nothing itself; it returns
the chosen effect. This also drains most of the risk out of the placement question
above: **where applicability is evaluated stops determining where the effect runs.**

`ActionContext` is built from the shared `DocumentProjection`, never the
renderer-only `DocumentIndex`. The `scope` union is **read out of the existing
action set**, not designed up front: the node context menu already mixes node
actions (Move to, Add tag), panel actions (View as table/outline), and app actions.

### D2 — The context menu is an anchored view of the registry

The menu is anchored beside the node. Anchoring is the reason it survives:
**position carries the operand.** You can never mistake which node a right-click
menu acts on, whereas a centred overlay must state its operand in words.

**Filtering is two-layered, and both layers are required.** A view first declares
which `scope`s it accepts, then operands are resolved:

```
menu.render(registry.byScope('node', 'selection').filter(a => a.operands(ctx).length > 0))
```

Without the first layer, the app-scoped navigation entries D3 adds (Go to Today,
Library, …) resolve operands in every context and surface inside the right-click
menu, breaking the equivalence criterion below. The command surface accepts every
scope; the context menu accepts only `node` and `selection`.

**One registry, two projections — and that is the whole seam.** Anchored
(browsable, operand carried by *position*) and searchable (typed, operand carried
by the chip). They are not two implementations and not two habits: the same entry
renders in both, with the same name and the same effect. What differs is only how
the operand gets there.

**Equivalence is the acceptance criterion**, and it is proven by **differential
test against the old code, not by a hand-written state table.** Enumerating "every
state the current menu distinguishes" (selection size, in-Trash, descendant
constraints, node type, field rows, panel mode) is itself a design task; miss one
dimension and the proof passes while behaviour changed. Instead the old menu path
stays in the tree for the duration of the PR as the **oracle**: both paths render
over a corpus of real document states and their outputs are asserted equal. The
old path is deleted in the PR's final stage.

### D3 — The command surface is the registry's searchable view, and the only hotkey

- **`Cmd+Shift+Space` everywhere; `Cmd+K` retires.** Delete
  `global.command_palette` (`shortcutRegistry.ts:139`) and the `Cmd+K` hint on the
  `/` menu's palette row (`slashCommands.ts:71`).
- **One rendered surface: the existing launcher panel.** `CommandPalette.tsx` is
  deleted. The launcher is already a superset of it (node search + open in the main
  window + "new node in Today").
- **Navigation destinations become registry entries** (`target: 'app'`): Go to
  Today / Library / Schema / Saved searches / Trash. They are already implemented,
  so they cost nothing — and a surface that claims to be the universal entry point
  cannot be missing the app's own destinations. ("The sidebar shows them anyway" is
  not a reason to omit them: by that logic the context menu would justify omitting
  every node action.)
- **In-app summon must not read external context.** Today the hotkey classifies
  Tenon itself as `unknown-app`; when the main window is frontmost, skip the
  external capture and attach in-app context instead (D4).
- **Return focus.** After a jump or an action, focus goes back to the editor
  position it came from.

### D4 — The chip is the operand, pre-filled and removable

There is **one** concept here, not two. The chip is not "attached context" that
separately happens to be actionable — it **is the operand**, the thing actions in
this surface apply to. Ambient context only decides its *default value*: in-app the
focused or selected node (pushed from the main renderer over IPC), out-of-app the
foreground page. Naming it "context" was what made it look like two things.

- Pre-filled on summon, **always visible** — nothing is ever attached silently.
- **Removable**, because a default is a guess: remove it and the surface falls back
  to global search with no operand.
- Carried, not merely displayed — which is what lets this surface reach a target
  that is not on screen. That is the one thing direct manipulation cannot do, and
  the reason the context menu itself grew a search box inside *Move to*.

**A multi-node selection is one aggregate chip** ("5 nodes"), expandable to remove
individually — not five chips. Five chips overflow a 760px panel and make "remove
everything → global search" ambiguous, and the actions that accept a selection take
the set, not its members.

**Focus versus selection is not a new rule** — the operand resolves through the
shipped `contextMenuSelection.resolveActiveNodeSelection`: the selection wins only
when the focused node is *part of* a multi-selection (collapsed to roots by
`selectedRootIds`), otherwise the focused node alone, with reference rows resolving
to their target. Reusing it is what makes the two projections (D2) agree by
construction instead of by inspection.

### D5 — One retrieval implementation

Every "find a node" path resolves through the shared retrieval service
(`main/nodeRetrievalService.ts`): the command surface, the context menu's *Move
to* picker, and the `@`/`#`/`/` candidate lists. Same ranking, same ordering,
everywhere. Where a path needs renderer-local latency it consumes the same
ranking primitives rather than re-deriving them.

### D6 — Rows are objects; the action bar says what Enter does; `⌘K` opens the rest

The Raycast model, and **half of it already ships**. A row is a pickable *thing* —
a node, the captured page, a command, a registry action — rendered as
`glyph · title · subtitle · right-aligned type label` in one flat list with no
section headers. Rows are never rewritten into verb phrases ("Open · Project A");
what Enter will do lives in the **action bar**, not in the row.

| Element | Rule | State |
|---|---|---|
| Row | the object, uniform shape, type label right-aligned | ships (`rowView`) |
| Action bar, left | the highlighted row's primary action + `↵` | ships (`LauncherApp.tsx:243`, `primaryActionLabel`) |
| Action bar, right | `Actions ⌘K` | **new** |
| `Enter` | run the primary action | ships |
| `⌘K` / click | open the highlighted row's full action list | **new** |

`LauncherItem.actions[]` has been an array since #103 precisely so secondary
actions could return additively (`spec/launcher.md`). This is connecting a seam
that was left open, not inventing one.

**`Cmd+K` is not retired, it is relocated** — from "open the command surface" to
"show this row's actions", inside the surface. Same instinct (*give me more
options*), reused rather than destroyed, and identical to Raycast's binding.

**Ordering** extends the shipped rule in `buildLauncherItems` (capture row → node
matches → commands) rather than replacing it; registry actions slot into that
sequence. Retrieval and the registry both feed one list.

**Default highlight is a fixed rule, never learned:**

- page context attached → the capture row;
- an operand chip but no query → the chip's applicable actions are the rows;
  highlight the first;
- otherwise → the first search result, or nothing when the query is empty.

Rationale for keeping it fixed: a user who types-and-blindly-Enters always exists.
Putting a document-mutating action under a blind Enter buys one saved arrow key and
costs the habit of blind-Enter entirely the first time it surprises them.

### D7 — Hidden without an operand; shown with a reason when a predicate fails

Pure `when`-clause hiding (the VS Code model) has a dead end in a *searchable*
list: you type "move", get nothing, and cannot tell whether the action does not
exist or merely does not apply right now. VS Code survives that because its command
names come from documentation; this action set is learned by exploration. So two
tiers:

- **No operand at all** (empty query, no chip, no selection) → node/selection
  actions are **hidden**. Opening the surface must not present a screen of things
  that cannot run.
- **An operand exists but a predicate rejects it** → the action is **shown with its
  reason** ("Move to — unavailable in Trash"), not silently dropped. A reason
  teaches the rule; a disappearance teaches distrust.

The context-menu view keeps its current behaviour under the same rule, since it
always has an operand. Inside the command surface the tiers apply to the `⌘K`
action list for the highlighted row; the flat result list itself is never padded
with rejected actions.

### D8 — Action naming is part of the contract

In a menu, position and icon carry meaning; in a searchable list only the name
does. Every registry entry gets a reviewed, searchable name in **both** locales
(`spec/i18n.md`). Names are reviewed as a set, not one at a time.

### D9 — Every panel-fired action reports its result; capture closes its loop

**The general rule first:** the panel does not activate the main window and
dismisses itself when an action runs, so **any** action fired from it must return a
visible result signal. "Move X into Y" from the panel has exactly the same problem
as a capture — the surface vanishes and the user may not be looking at the window
where it landed. One rule, not a capture special case.

**Ordering, so the signal never fights focus return (D3):** an action is
**committed the moment it fires** and cannot be cancelled from the panel; focus
returns immediately; the result signal is a notification that never takes focus and
never blocks dismissal. Esc during the signal dismisses the signal, never the
action — reversal is `Cmd+Z` in the document, the same undo everything else uses.

- **Destination is Today.** No picker, no Inbox.
- **Success is visible.** Capture currently resets and hides with no confirmation
  (`LauncherApp.tsx:121-127`) — when Tenon is in the background the user gets no
  evidence at all. Show a brief confirmation before dismissing.
- **One optional user tag at capture time.** Findability comes from tags and
  search, not from location. (The capture-kind tag `#article`/`#video` → `#capture`
  already exists; what is missing is *the user's own* tag.)
- **"Send to the agent panel" is a registry action, not a new AI surface.** It
  raises the main window, reveals the rail, and stages the page/node as a
  reference in the composer — the user types and submits. Shape and contract come
  from `agent/agentReveal.ts` and `agent-conversation-model.md` /
  `agent-data-model.md` (which own `ThreadUserContent`; this plan must not
  re-describe it).

### D10 — Out-of-app fidelity chain

Structured read (AX browser tab) → URL + title → clipboard → manual entry. No
screenshot tier. Read nothing → no chip, degrade to a plain note. Per A12 this
path degrades; it never throws on the user's action.

## Shape and build order

**Shape (a): one complete feature in one PR.** The stages below are build order
*within* that PR, not releases.

0. **Spike:** the migration cost of the predicates into core (D1, open question 1).
   Confirms stage 2's shape, or triggers the named contingency, before it is built.
1. **Converge node retrieval** onto the shared service (three implementations →
   one). *Highest user-visible payoff and independent of everything below* — it is
   not a dependency of the registry, so it goes first rather than fourth. If the PR
   is ever cut short under pressure, the part that mattered has landed.
2. Registry + predicates in core (D1), per the stage-0 verdict.
3. Populate the registry. **First population is exactly** the node context menu's
   action set plus the navigation destinations (D3) — a bounded, already-implemented
   set. Menu-bar items with no keyboard path are a later pass, not this PR: the
   registry's value is that adding them later is cheap.
4. Re-render the context menu as a registry view, **differentially proven against
   the old path** (D2), which stays in the tree as the oracle.
5. Render the registry as the command surface's searchable view: rows into the
   existing ordering, `Actions ⌘K` into the existing action bar and the action
   list behind it (D6), in-app context path and aggregate chip (D4), focus return
   and result signal (D9).
6. Capture loop: confirmation, optional tag, send-to-agent action.
7. Delete the old menu path, `CommandPalette.tsx`, the global `Cmd+K` binding
   (`shortcutRegistry.ts:139` — the keystroke lives on inside the panel as
   *Actions*), and the stale `/`-menu hint.

Stages 2-4 change no user-visible behaviour, which is what makes a PR this size
reviewable: they are provable mechanically.

**Where the split line is, if one is ever forced.** Stage 1 is independently
complete. Stages 6's confirmation and tag work touch neither the registry nor
retrieval — they ride in this PR for review-bandwidth reasons, not architectural
ones. ("Send to the agent panel" is genuinely a registry action and belongs here.)

## Verification

- **Menu equivalence (stage 4).** Differential: the old menu path is the oracle and
  both paths render over a corpus of real document states; outputs must be equal.
  Cousin of #445's golden Item-stream parity — compare against the real thing, do
  not hand-enumerate the states that matter.
- **Retrieval convergence (stage 1).** One ranking chokepoint; a test asserts the
  same query returns the same ordering from every entry point.
- **Scope filtering (D2).** Assert no `panel`/`app`-scoped action can reach the
  context menu — the failure mode the navigation entries introduce, and the one
  that would silently break menu equivalence.
- **Applicability (D7).** Property test: every rendered action either applies, or
  is rendered with its rejection reason. Nothing silently inapplicable.
- **Action result signal (D9).** E2E: fire a mutating action from the panel with
  the main window in the background; assert the user gets a result signal.
- **Capture (D9).** E2E: capture with a tag from a background app, assert the node,
  the tag, and the confirmation.
- Light + dark visual verification (UI diff); `typecheck`, `test:core`,
  `test:renderer`, `test:e2e`, `docs:check`.

## Open questions

1. **Migration cost of the predicates into core (D1)** — they are pure but typed
   against `DocumentIndex`; the adapter cost onto `DocumentProjection` is the one
   real unknown, and the stage-0 spike measures it before stage 2 is built. If it
   proves expensive, the contingency is to keep the definitions in the renderer and
   hand the panel an evaluated list over IPC — the pattern `launcher:searchNodes`
   already ships. That costs out-of-app actions on a node operand and nothing else,
   so this question cannot block the PR.
2. Does the launcher keep its own icon table (`launcherIcons.tsx`, deliberately
   outside the renderer's `icons.ts` so the launcher bundle stays small), or do
   registry entries carry icon ids resolved per view? See `icon-semantics.md`.
3. What the non-focus-stealing result signal (D9) actually is: a brief in-panel
   dwell before dismissal, an OS notification, or a main-window surface? The
   ordering is settled; the presentation is not, and it must work with Tenon in
   the background.

## Related plans

- `floating-toolbar-polish.md` — its *Destination policy* question is answered by
  the same ruling as D9 (Today, no special bucket); its `#` selection-extract is a
  registry action once the registry exists.
- `embed-strategy.md` — resolved as option C (delete the dead `embedType`/`embedId`
  schema). This is why D9 needs no rich rendering.
- `launcher-provider-expansion.md` — provider breadth is downstream of that ruling
  and drops in priority accordingly; this plan consumes classification, never owns
  it. (Breadth becomes worth more once the static reader lands, since a recognised
  provider then yields real content rather than a better-labelled link.)
- `file-preview.md` — its **static URL reader** is the approved rich-extraction
  backend; capture consumes it through `PageContentExtractor` once it exists. That
  plan's open question ("is the static reader still valuable beside the hardened
  preview?") is answered yes by this decision: it has a second consumer.
- `browser-extension-integration.md` — record-only, and a **deferred second
  extraction source** (JS-rendered / signed-in pages) behind the static reader. Two
  corrections it needs: its filename says "extension" while its own non-goals
  exclude one, and it asserts the same not-yet-built "clipboard, screenshot"
  fallback chain that D10 corrects. Renaming it breaks the `docs/TASKS.md` link, so
  coordinate with the main agent.
- `agent-conversation-model.md` / `agent-data-model.md` — authorities for the
  handoff content shape in D9.

## Collision self-check

To re-run at build time. At drafting: the only open PR is #477
(`main-agent/e2e-pr-comparison`), no overlap. The build touches
`src/core/` (new registry + moved predicates), `src/renderer/ui/outliner/NodeContextMenu.tsx`,
`src/renderer/ui/CommandPalette.tsx` (deleted), `src/renderer/ui/interactions/*`,
`src/renderer/launcher/*`, `src/main/launcher/*`, `src/main/context/contextCapture.ts`,
and both locale message files. It does **not** touch `src/core/commands.ts` or
`src/core/types.ts` — the registry references existing commands rather than adding
mutations.

## Appendix — provenance

Why this shape rather than another. Kept so the settled boundaries are not
silently re-opened; not needed to build the design above.

### The evidence

The repository already contains the controlled experiment, one line right and one
line wrong:

| Action | Entry points | Implementations | Result |
|---|---|---|---|
| Apply a tag | `#` trigger popover, node context menu, batch selector, `TagSelector` | **one** (`ui/interactions/tagSelector.ts`) | four doors, **one habit** |
| Find a node | context-menu *Move to*, `@`/`#`/`/` candidates, command palette, launcher | **three** | same query, **three different orderings** |

`NodeContextMenu.tsx:222-230` filters the whole projection with `.includes()` and
**no ranking at all**; `ui/interactions/candidateRanking.ts` ranks by text match;
`main/nodeRetrievalService.ts` ranks with the personal-access boost (#111, #307).
Searching "project" in *Move to* and in the command surface returns different
orders today. That divergence — not the number of surfaces — is the defect.

### Reference source and its boundary (Lazy)

This surface started as "build a Lazy-like command window, and merge it with the
in-app `Cmd+K` that looks similar." The reverse-engineering record is
`archive/lazy-like-global-launcher.md` (Lazy v2.0.10, analysed 2026-06-02); its
first slice shipped as #103 and is now `spec/launcher.md`.

**Borrowed — the feel.** One global hotkey, no modes, one always-focused input
that is simultaneously filter / search / draft, fuzzy match, Enter runs the
highlighted row, a non-activating panel that never makes you leave what you were
doing. This shipped and this plan preserves it.

**Borrowed — the row / action-bar split.** Rows are objects with a right-aligned
type label; the primary action lives in the bottom bar with `↵`, and the rest
behind `Actions ⌘K` (D6). Tenon already ships the left half.

**Borrowed — the command surface as *the* entry point.** Lazy's launcher is a
command runner, not a search box. That ambition is what the action registry (D1)
delivers — but populated from **Tenon's own action set**, not Lazy's.

**Not borrowed — Lazy's command families.** The observed table
(`Clip article` / `Clip PDF` / `Clip email` / `Clip DM` / `Read later` /
`Watch later` / `Summarize video` / `Generate tags`, ibid. §"Lazy command families
observed") is entirely *bring the outside in*; **not one entry operates on the
user's own notes.** So Lazy's window and Tenon's `Cmd+K` were never two similar
things — they share a silhouette, not a job. Merging them therefore needed an
abstraction spanning two non-overlapping jobs, and `Target × Verb` was invented to
fill an intersection that does not exist. That is why the earlier revision of this
plan grew a verb matrix, a chip-arity model, habit learning, and a reversibility
tier. **The merge still happens here** — one hotkey, one surface,
`CommandPalette.tsx` deleted — but because the launcher is already a superset of
the palette, not because two similar things were fused.

**Structurally out of reach.** Half of Lazy's table (DMs, email, LinkedIn/X
threads, anything signed-in) requires injecting JS into the *user's own browser* —
an extension or CDP. **Tenon builds no extension** (PM, iteration change). The
approved rich-extraction backend is a **main-process static URL reader** — fetch +
parse, no injected JS, no new OS permission — which covers public articles, blogs,
videos, and repos: what capture actually meets most of the time. The seam is
already in the code (`PageContentExtractor`, `contextCapture.ts`); only the
implementer changed. Reading an already-visible Tenon URL Preview stays a deferred
*second* source for JS-rendered or signed-in pages.

**Direction check.** Lazy is a read-later/collection product; Tenon is a context +
agent workbench. Deleting the `embedType`/`embedId` schema (`embed-strategy.md`,
option C) is a deliberate step *away* from read-later. Capture here earns its keep
by being findable and agent-readable (D9), not by looking rich.
