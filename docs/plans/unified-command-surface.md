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

### Reference source and its boundary (Lazy)

This surface started as "build a Lazy-like command window, and merge it with the
in-app `Cmd+K` that looks similar." The reverse-engineering record is
`archive/lazy-like-global-launcher.md` (Lazy v2.0.10, analysed 2026-06-02); its
first slice shipped as #103 and is now `spec/launcher.md`. Record what is borrowed
and what is not, so this boundary is not silently re-opened:

**Borrowed — the feel.** One global hotkey, no modes, one always-focused input
that is simultaneously filter / search / draft, fuzzy match, Enter runs the
highlighted row, a non-activating panel that never makes you leave what you were
doing. This shipped and this plan preserves it.

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

### The evidence this plan is built on

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

### D1 — The registry lives in `src/core/`, not the renderer

This is the load-bearing decision. The command surface's out-of-app view runs in
the **locked-down launcher renderer, which has no document** (`spec/launcher.md`:
it resolves search hits over IPC precisely because it cannot read the projection).
So a registry that lives in renderer state cannot serve both views.

Registry entry shape:

```ts
interface ActionDefinition {
  id: ActionId;                      // stable, i18n-independent
  target: 'node' | 'selection' | 'panel' | 'app';
  applicable(ctx: ActionContext): readonly NodeId[] | boolean;
  command: CoreCommandRef;           // A4: mutation goes through core commands
}
```

`ActionContext` is built from the shared `DocumentProjection` (already crosses
IPC), never from the renderer-only `DocumentIndex`. The predicates that decide
applicability **already exist as pure functions** — `idsAllowedForMoveTo`,
`idsAllowedForDuplicate`, `idsEnabledForSelectionAction`,
`idsAllowedForStructuralBatch/IndentBatch/OutdentBatch`, `planSelectionDelete`,
`trashActions.ts`, `nodeLocation.isNodeInTrash`,
`contextMenuSelection.resolveActiveNodeSelection`. The work is moving them from
`renderer/ui/interactions/` to core and re-basing them on `DocumentProjection`,
not writing new logic.

The `target` union is **read out of the existing action set**, not designed up
front: the node context menu already mixes node actions (Move to, Add tag),
panel actions (View as table/outline), and app actions.

### D2 — The context menu is an anchored view of the registry

The menu renders `registry.filter(applicable(clicked node))`, anchored beside the
node. Anchoring is the reason it survives: **position carries the operand.** You
can never mistake which node a right-click menu acts on, whereas a centred
overlay must state its operand in words.

**Equivalence is the acceptance criterion:** for every node state the current menu
distinguishes (single/multi selection, in-Trash, descendant constraints, field
rows), the registry-driven menu must render the *same action set in the same
order*. This is a behaviour-preserving refactor and is proven mechanically.

### D3 — The command surface is the registry's searchable view, and the only hotkey

- **`Cmd+Shift+Space` everywhere; `Cmd+K` retires.** Delete
  `global.command_palette` (`shortcutRegistry.ts:139`) and the `Cmd+K` hint on the
  `/` menu's palette row (`slashCommands.ts:71`).
- **One rendered surface: the existing launcher panel.** `CommandPalette.tsx` is
  deleted. The launcher is already a superset of it (node search + open in the
  main window + "new node in Today"); the only thing it lacks is the five static
  navigation rows, which the sidebar shows permanently anyway (`workspace-layout.md`:
  Today / Library / Recents / Schema / pinned nodes).
- **In-app summon must not read external context.** Today the hotkey classifies
  Tenon itself as `unknown-app`; when the main window is frontmost, skip the
  external capture and attach in-app context instead (D4).
- **Return focus.** After a jump or an action, focus goes back to the editor
  position it came from.

### D4 — Context is attached and removable

Ambient context attaches on summon and renders as a visible, removable chip:
in-app the focused/selected node (pushed from the main renderer over IPC),
out-of-app the foreground page. Removing every chip falls back to global search.
Nothing is ever attached silently.

The chip is the **operand the surface carries**, which is what lets it reach a
target that is not on screen — the one thing direct manipulation cannot do, and
the reason the context menu itself grew a search box inside *Move to*.

### D5 — One retrieval implementation

Every "find a node" path resolves through the shared retrieval service
(`main/nodeRetrievalService.ts`): the command surface, the context menu's *Move
to* picker, and the `@`/`#`/`/` candidate lists. Same ranking, same ordering,
everywhere. Where a path needs renderer-local latency it consumes the same
ranking primitives rather than re-deriving them.

### D6 — Enter contract and default highlight

Enter fires the highlighted row's action, and every row shows that action inline.
The default highlight is a **fixed rule**, never learned:

- page context attached → the capture row;
- otherwise → the first search result, or nothing when the query is empty.

Rationale: a user who types-and-blindly-Enters always exists. Putting a
document-mutating action under a blind Enter buys one saved arrow key and costs
the habit of blind-Enter entirely the first time it surprises them.

### D7 — Applicable-only, never disabled

An action that does not apply to the current context **does not appear** (the
VS Code `when`-clause model). A searchable list that surfaces inapplicable rows
teaches users to distrust it.

### D8 — Action naming is part of the contract

In a menu, position and icon carry meaning; in a searchable list only the name
does. Every registry entry gets a reviewed, searchable name in **both** locales
(`spec/i18n.md`). Names are reviewed as a set, not one at a time.

### D9 — Capture closes its loop

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
*within* that PR (A7: settle the mechanism before its consumers), not releases.

1. Move the applicability predicates to core, re-based on `DocumentProjection`.
2. Define the registry and populate it from the node context menu's action set.
3. Re-render the context menu as a registry view — **behaviour identical**.
4. Converge node retrieval onto the shared service (three implementations → one).
5. Render the registry as the command surface's searchable view; add the in-app
   context path and focus return.
6. Capture loop: confirmation, optional tag, send-to-agent action.
7. Delete `CommandPalette.tsx`, the `Cmd+K` binding, and the stale `/`-menu hint.

Stages 1-3 change no user-visible behaviour, which is what makes a PR this size
reviewable: they are provable mechanically.

## Verification

- **Menu equivalence (stages 1-3).** A generated table of (node state → action set,
  in order) captured on `main` before the refactor must match the registry-driven
  menu exactly. Same technique that carried #451's 4,700-line move to zero review
  findings: freeze the observable surface, prove it unchanged, then build on it.
- **Retrieval convergence (stage 4).** One ranking chokepoint; a test asserts the
  same query returns the same ordering from every entry point.
- **Applicability (D7).** Property test: no rendered action is inapplicable to the
  context it was rendered for.
- **Capture (D9).** E2E: capture with a tag from a background app, assert the node,
  the tag, and the confirmation.
- Light + dark visual verification (UI diff); `typecheck`, `test:core`,
  `test:renderer`, `test:e2e`, `docs:check`.

## Open questions

1. How much of `renderer/ui/interactions/` can move to core without churning
   unrelated call sites? The predicates are pure, but they are typed against
   `DocumentIndex`; the adapter cost is the main unknown in stage 1.
2. Which panel/app-scoped actions belong in the registry's first population —
   only what the node context menu already offers, or also menu-bar items with no
   keyboard path?
3. Does the in-app context chip carry the focused node, the selection, or both
   when they disagree?
4. Does the launcher keep its own icon table (`launcherIcons.tsx`, deliberately
   outside the renderer's `icons.ts` so the launcher bundle stays small), or do
   registry entries carry icon ids resolved per view? See `icon-semantics.md`.
5. Confirmation UX for capture: in-panel dwell before dismiss, or a main-window
   surface the user may not be looking at?

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
