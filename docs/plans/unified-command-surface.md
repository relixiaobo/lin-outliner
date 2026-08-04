# Unified Command Surface

## Goal

**One action registry** behind every surface that acts on an outline node.

- The node context menu becomes a *filtered, anchored view* of the registry.
- The command surface becomes the registry's *searchable view* — and the only
  one summoned by a hotkey, in-app and out-of-app alike.
- The context menu is a **subset**, never a second implementation. **In-app the
  command surface covers all of it.** Out of app it covers everything that does not
  need a fact only the main renderer can attest — one rule, from which the exact
  inventory follows (D1). Stated here rather than promised away.

The user-visible promise: **one action, one habit.** Multiple entry points are
fine; multiple implementations are not.

**Shape (b): two independent complete features**, split at the proof boundary
(see *Shape and build order*). PR 1 makes the context menu a view of the registry
with **zero behaviour change**, mechanically proven, and fixes the `Move to`
picker. PR 2 builds the command surface and the capture loop on that foundation.

**The retrieval promise is scoped to what actually ships.** This plan converges the
*node-picker* paths — the command surface (already shared) and `Move to` (which has
no ranking at all). The at-caret `@`/`#`/`/` candidate paths keep their typed domain
policies and are **not** folded onto the shared kernel here; D5 says why, and doing
it is a separate, separately-judged change.

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

**What this delivers, stated honestly.** Only three things here are immediately
felt — retrieval convergence (the context menu's *Move to* can currently fail to
show a target at all), capture confirmation, and asking the agent about a page from
outside the app. Everything else is reachability at the margin. The daily writing
loop does not get faster; that belongs to `performance-optimization.md`. Judge the
result against that claim, not a broader one.

**Where the registry's real value is.** Not merely that future actions get a
keyboard path for free. Because `effect` is a serializable instruction, the registry
lives in core, and *composer handoff* is already one of the effect ops (D9), this is the
seam where **an agent capability becomes a user-callable command** — the same
catalog, the same names, the same operand resolution, whether a person picks it or
a Skill exposes it. For a product aimed at directing local agents, that is not debt
repayment; it is the floor the product surface stands on.

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
  is a main-process static URL reader; this plan neither builds nor blocks it, and
  the capture loop (D9) works with or without it. Provider breadth stays in
  `launcher-provider-expansion.md`. **No browser extension is built by anyone** —
  `browser-extension-integration.md` is a historical filename for a plan whose own
  non-goals exclude extensions.

  **It is a separate API, not the ambient seam.** `captureExternalContext` runs on
  *every* hotkey press (`main.ts:1618-1634`), so nominating `PageContentExtractor`
  as the reader's home would fetch whatever page is in front of the user before they
  chose anything — one silent outbound request per summon. So the reader gets its
  own explicit entry point:

  ```ts
  interface ExplicitPageReader { read(url: string, signal: AbortSignal): Promise<PageReadResult>; }
  ```

  called **only** by a chosen capture or agent action, with cancellation,
  SSRF/local-address restrictions and persistence semantics owned there.
  `PageContentExtractor` stays what it is: an ambient metadata hook with no
  implementation. The contracts differ anyway — `GenericWebpageRaw` is metadata with
  no body, the capture sidecar stores provenance, not content.
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
*applicability* is renderer-bound today.

**Stage-0 spike: done, and the answer is clean.** The selection family's signature
is `{ ids, panelRootId, byId, rowMap?: ReadonlyMap<NodeId, SelectableRow> }`
(`selectionBatchActions.ts:26-125`), which reads like three renderer dependencies.
Traced to the bottom, it is one:

- **`rowMap` is a cache, not a dependency.** `resolveSelectableRow` is
  `rowMap?.get(id) ?? selectableRowForId(id, panelRootId, byId)` — the derivation
  path already exists and already runs whenever no cache is passed.
- **`actionPolicy` derives from the projection alone.**
  `selectableRowFor` computes `kind` from `(id, node, parent)`, `stored` from
  node presence and a synthetic-id test, `mutable` from `stored && !node.locked`,
  and `actionPolicy = actionPolicyFor(kind, mutable)`
  (`state/selectableRows.ts:252-292`). No view config, no expansion state, no UI
  state. `SelectableRowsOptions.expanded` is needed to *list visible rows*, never to
  decide what one row permits.
- **`panelRootId` is consumed by exactly one predicate**:
  `idsAllowedForStructuralOutdentBatch` returns `row.parentId !== panelRootId` —
  you cannot outdent out of the panel's own root. Everywhere else it is threaded
  through and never read.

**So the registry and its predicates live in `src/core/`.** Evaluation reads
exactly two things — the document, and what the user is acting from:

```ts
interface ActionContext {
  projection: DocumentProjection;   // crosses IPC already
  invocation: ActionInvocation;     // the composite envelope in D1a
}
```

`panelRootId` lives inside `invocation.panel` rather than beside the projection,
because it is a fact about *where the user is acting*, not about the document.
There is one shape, not two.

**Out-of-app coverage follows one rule, and the inventory is derived from it, not
listed by hand.**

> An action resolves `absent` out of app **iff** it requires an invocation part only
> the main renderer can attest — `panel` or `workspace`.

Applying it to the current set:

| Absent out of app | Why |
|---|---|
| every `panel`-scoped entry — *View as*, *Filter/Sort/Group/Display*, *Show/Hide view toolbar* | no `invocation.panel` |
| *Outdent* | reads `panelRootId` (`idsAllowedForStructuralOutdentBatch`) |
| *Pin* / *Unpin* | read `workspace.isPinned` |

Everything else — including *Open in split pane*, which consumes neither part —
resolves identically in both views. **This is not a lesser build**: each entry is
defined relative to a workspace or panel that genuinely is not there, which is D7
doing its job. Earlier drafts said "exactly two", which was wrong in both directions;
the rule is the contract and the table is its consequence.

### D1a — Five contracts, not one interface

Two review rounds killed a single `ActionDefinition` written in prose, each time
because one field could not hold the real action set. The failure was structural:
**a type asserted in a document cannot be falsified.** These land as compiling
TypeScript in PR 1 (see *Shape*), populated with the whole existing action set, so
the compiler decides whether they hold.

```ts
// 1. INVOCATION — what the user is acting from. Main-owned; crosses the seam as an id.
//    A COMPOSITE ENVELOPE, not a union: one menu opening carries several of these
//    at once, and D2 renders node + selection + panel actions from that one opening.
interface ActionInvocation {
  anchor?:    { nodeId: NodeId; targetId: NodeId };
  selection?: { nodeIds: readonly NodeId[] };          // live multi-selection, if any
  panel?:     { panelId: string; panelRootId: NodeId };
  page?:      { contextId: ExternalContextId };        // main holds the ExternalContext
  // ATTESTED by the main renderer only (sender-checked; see D1b). Never suppliable
  // by the launcher. Its absence is what makes the entries in D1's table resolve
  // `absent` out of app.
  workspace?: { visualRowId: NodeId; isPinned: boolean; rowExpanded: boolean };
}

// 2. EVALUATION — three states, never a bare list. D7 needs to tell them apart.
type ActionEvaluation =
  | { status: 'applicable'; operands: ResolvedOperands }
  | { status: 'rejected';   reason: ActionRejection }   // shown WITH the reason
  | { status: 'absent' };                               // no operand at all → hidden

// 3. PRESENTATION — what a view renders. Both locales; icon by id, resolved per view.
interface ActionPresentation {
  id: ActionId; names: LocalizedNames; iconId: IconId;
  evaluation: ActionEvaluation;
  parameter?: ParameterSpec;      // a second step (Move to → destination, Add tag → tag)
  confirm?: ConfirmationSpec;     // Delete forever, Empty Trash
}

// 4. REQUEST — the ONLY thing a renderer may send. No command, no effect, and
//    no self-asserted confirmation: a boolean would be convention, not admission.
interface ActionRequest {
  actionId: ActionId; invocationRef: InvocationRef;
  parameter?: ActionParameterValue;
  challenge?: ChallengeToken;       // minted by main; single-use; see D1b
}

// 4b. INVOCATION RECORD — main-owned. The ref is an opaque handle to this.
interface InvocationRecord {
  invocation: ActionInvocation;
  origin: 'main' | 'mainRenderer';  // main-origin records are first-class, not a fiction
  // Present IFF the envelope carries `panel` or `workspace`. Those are the only
  // parts a renderer can attest; anchor / page / app facts main derives itself.
  attestation?: { webContentsId: number; renderGeneration: number };
  consumableBy: RendererId;
  openSeq: number | null;           // null when not bound to a launcher opening
  phase: InvocationPhase;           // atomic; see D1b
  expiresAt: number;
}
type InvocationPhase = 'live' | 'confirming' | 'executing' | 'spent';

// 4bis. CREATION — the ref every request needs has to come from somewhere, and a
//    renderer must not be able to author the parts main is supposed to attest.
type InvocationSeed =
  // main-renderer only; SENDER-CHECKED. Carries renderer-owned FACTS, never a
  // finished ActionInvocation: main validates the ids, resolves reference targets
  // and selection roots, and mints origin / attestation / lifetime / consumer.
  | { from: 'mainRenderer'; anchorNodeId: NodeId; visualRowId: NodeId;
      selectedIds: readonly NodeId[]; panelId: string;
      isPinned: boolean; rowExpanded: boolean }
  // Main-origin invocations are built INSIDE main and never arrive over IPC:
  // captured page, node-search result, app-scoped entry.
  ;
interface InvocationOpened { invocationRef: InvocationRef; presentations: readonly ActionPresentation[] }

// 4c. LIFECYCLE EVENT — the other inbound message. Like ActionRequest it can only
//     NAME a transition; main decides whether it is legal in the current phase.
type InvocationEvent =
  | { kind: 'confirmationCancelled'; invocationRef: InvocationRef; challenge: ChallengeToken }
  | { kind: 'abandoned'; invocationRef: InvocationRef };   // menu closed, chip removed

// 5. EFFECT — produced by main, never accepted from a renderer. An ORDERED PLAN,
//    because real actions cross executors: `Filter / Sort / Group / Display` runs
//    setViewToolbarVisible and only THEN reveals the section.
interface ActionEffectPlan {
  steps: readonly EffectStep[];       // in order; a failed step stops the plan
  completion: 'restoreInvoker' | 'stayAtDestination';   // D9 focus policy, per action
}

// Only these commands may be bound, and this is what they guarantee. Declared in
// src/core/actions/ over EXISTING command names — no commands.ts change.
interface BindableCommandResults {
  ensure_date_node: { focusNodeId: NodeId };
  create_tag:       { focusNodeId: NodeId };
}
type BindableCommand = keyof BindableCommandResults;
type Bound<T> = T | { fromStep: StepRef; field: 'focusNodeId' };

// Mapped union: args are correlated WITH the command name, and `bindAs` exists only
// where a result exists to bind.
type CommandStep = {
  [K in CommandName]: {
    on: 'main'; kind: 'command'; command: K; args: BoundArgs<CommandArgs[K]>;
  } & (K extends BindableCommand ? { bindAs?: StepRef } : { bindAs?: never })
}[CommandName];

type EffectStep =
  | CommandStep
  // `Bound<NodeId>` wherever a consumer legitimately reads a previous step's result.
  | { on: 'mainRenderer'; kind: 'navigate'; nodeId: Bound<NodeId>; inPlace: boolean }
  | { on: 'mainRenderer'; kind: 'reveal'; surface: RevealTarget }
  | { on: 'mainRenderer'; kind: 'workspace'; op: 'pin' | 'unpin' | 'openSplitPane'; nodeId: Bound<NodeId> }
  | { on: 'main';     kind: 'clipboard'; text: string }   // main resolves + writes it
  | { on: 'mainRenderer'; kind: 'composerHandoff'; operand: ComposerOperand; draftText: string };

// 5b. REQUEST RESULT — what an ActionRequest returns. The first Flow-A leg is a
//    response, not a side effect, so it needs a branch that can carry the token.
type ActionRequestResult =
  | { status: 'confirmationRequired'; challenge: ChallengeToken; confirm: ConfirmationSpec;
      presentation: ActionPresentation }        // authoritative copy + operands for the dialog
  | { status: 'reEvaluated'; presentation: ActionPresentation }   // stale operands; try again
  | ActionExecutionResult;

type ActionExecutionResult =
  | { status: 'completed' }
  | { status: 'failed'; atStep: number; reason: ExecutionFailure }
  // A missing ack does NOT prove the step did not run — see D9.
  | { status: 'indeterminate'; atStep: number; reason: 'ackTimeout' | 'rendererGone' };
type ExecutionFailure =
  | { kind: 'commandRejected'; code: string }   // main knows it did not run
  | { kind: 'rendererReported'; code: string }  // the renderer said so
  | { kind: 'notDelivered' }                    // never left main; provably did not run
  | { kind: 'bindingUnresolved'; step: number } // a bound result was missing at use
  | { kind: 'invocationStale' };
```

Why each exists, in the order the reviews forced them:

**Invocation is a composite envelope, not a union, because one opening is
composite.** A single right-click carries the anchored node *and* the live
multi-selection *and* panel/toolbar state *and* pin state simultaneously
(`NodeContextMenu.tsx:63-81`), and derives batch operands from the anchor and the
selection **together** (`:135-203`). D2 then renders node, selection and panel
actions from that one opening. A union admits exactly one of those, so a literal
implementation would have to drop actions, smuggle the rest in after admission, or
invent an undocumented multi-ref merge. The envelope carries them all; each action's
`operands()` reads the parts it needs and ignores the rest.

**Who supplies what, and where each fact stops being available.** Main derives
everything document-shaped from the projection (`targetId` resolution, descendant
and Trash exclusion, `mutable`, row policy). The `workspace` part is different in
kind, and the previous revision got it wrong by treating "renderer-owned" as one
category:

**Dependencies are declared per action, not per category.** Each entry names the
`workspace` fields it needs; the envelope is not an all-or-nothing gate. Bundling
them was an unnecessary parity loss:

- **Pin / Unpin need `isPinned`**, which lives in the *main renderer's* React state
  and localStorage (`useWorkspacePinnedNodes.ts`). The launcher is a **different
  renderer** with no access to it, so those two resolve **`absent` out of app** —
  the same shape as *Outdent* without a panel: the action is defined relative to a
  workspace that is not there.
- **Open in split pane needs nothing from `workspace`.** It carries a node id and
  routes to `mainRenderer` like any other step, so it **stays available out of
  app**. An earlier draft gated it on the whole bundle and lost parity for no
  reason.

**The toolbar toggle is the one place a renderer fact must reach a command, and it
gets a named exception rather than a bent rule.** The menu computes
`viewToolbarVisibleInRow = view.toolbarVisible && props.viewToolbarVisibleInRow`
and writes **its negation** into the command
(`NodeContextMenu.tsx:123-126`, `:407-413`). Enumerate it and `rowExpanded` is
load-bearing, not cosmetic:

| persisted | rowExpanded | writes | effect |
|---|---|---|---|
| true | true | `false` | hides |
| true | **false** | `true` | **no-op**, reveal only |
| false | either | `true` | shows |

Rows 1 and 2 differ *only* by the renderer bit, so deriving the argument from
main-owned state alone changes behaviour — the differential proof cannot hold under
"commands resolve entirely from main-owned state" as previously written.

So D1b gains **one exception, admitted by name and bounded by three conditions**
(see D1b). `rowExpanded` for `set_view_toolbar_visible` is the only entry that
qualifies today, and out of app the action resolves `absent` anyway, since there is
no main renderer to supply the bit.

**One opening produces one `InvocationRef` and one ordered `ActionPresentation[]`**,
so a menu never assembles itself from several refs.

**Evaluation has three states because D2 and D7 disagree about what "empty"
means.** D2 filters on applicability; D7 must show a rejected action *with its
reason* and hide an action that has no operand. One empty array cannot be both, and
carries no reason either way.

**Presentation is separate from definition** because the same entry renders in two
projections with different affordances, and because icon ids resolve per view
(below).

**Request is the admission contract** — see D1b. It is deliberately the smallest
thing that can name an action.

**Effect is an ordered plan, discriminated and outbound-only.** The action
inventory (~22 items) shows `mutate | navigate | handoff` under-counts badly: *Pin*
writes renderer workspace chrome (localStorage, not document state), *Open in split
pane* creates a panel, *Copy text* / *Copy node id* write the clipboard, *Add
description* and the *Filter / Sort / Group / Display* rows reveal UI. Only about
half are core commands, and each carries its own payload — `op + ...` is not an
executable contract.

**And some actions are not single-executor at all.** *Filter / Sort / Group /
Display* runs `setViewToolbarVisible` through the core command path and only **after
it succeeds** expands the visual row and reveals the requested section
(`NodeContextMenu.tsx:273-277`); *Show view toolbar* has the same command-then-reveal
shape (`:407-420`). A single effect would have to drop one half or let the action
escape back into an ad-hoc renderer callback — which would defeat both the registry
and the differential proof. Hence `steps`: **renderer steps are emitted only after
the preceding main step succeeds**, a failed step stops the plan, and D2's
equivalence proof compares **step order and failure behaviour**, not just the final
command.

**Ordering alone is still not enough — three more things the array had to carry:**

- **Result binding.** *Add tag → Create* runs `create_tag`, reads the returned
  `focus.nodeId`, and only then builds `apply_tag` / `batch_apply_tag`
  (`NodeContextMenu.tsx:260-269`). Steps therefore name their result (`bindAs`) and
  later steps reference it (`{ fromStep, field }`) — a constrained reference, not a
  general expression language.

  **Decided now, not during implementation: bound references are the contract, and
  the compound-command alternative is closed.** A `create_and_apply_tag` command
  would add a mutation-protocol entry to serve exactly one action, while the binding
  already expresses it and is reusable by any future create-then-use pair. So
  **`src/core/commands.ts` is untouched** by both PRs, and no interface-first PR is
  needed. Leaving this to "PR 1 with the compiler in hand" was wrong: the protocol
  surface is exactly what the flow requires settled at approval time (A4, A7).
- **A renderer target.** For a launcher invocation, `navigate` / `workspace` /
  `composerHandoff` must run in the **main renderer**, not the calling launcher
  renderer — the composer handoff is in-process pub/sub and the pin hook lives in
  the main renderer.
- **Clipboard is a *main* step, and carries the resolved text.** An earlier draft
  routed it to the invoker with `{ payload: 'text' | 'nodeId', nodeId }`. That works
  for *Copy node id* and is impossible for *Copy text*: the launcher deliberately
  cannot read the document, while the menu copies `textOf(target, untitled)` from
  its own projection (`NodeContextMenu.tsx:421-425`). Main already owns the
  projection, so it resolves the bounded string and writes it with Electron's
  `clipboard` — no data crosses to a renderer, and no read-back IPC is added for
  something main already has. The **untitled fallback** is part of the differential
  proof.
- **Acknowledgement.** Main routes a renderer step and **waits for its ack** before
  emitting the next step, so a failed renderer step stops the plan and surfaces as
  `ActionExecutionResult.failed` — which is what D9's result state displays. Without
  it main cannot know a renderer step failed and the promised failure semantics are
  untestable.

**The command step is a mapped union, or the compiler proof is a fiction.** A
`command: CommandName` beside a loose `args` is not correlated — the wrong args pair
with a command and still compile — and `documentService` accepts a `DocumentCommand`
plus `Record<string, unknown>`, so there is no existing correlation to inherit. The
registry is where it gets created, as a type-level map over **existing** command
names in `src/core/actions/` (still no `commands.ts` change). Two more fences come
with it: `bindAs` exists **only on commands that declare a bindable result**, so a
`clipboard` or `reveal` step cannot pretend to produce a `focusNodeId`; and
`Bound<NodeId>` appears in **every consumer field that legitimately reads one** —
including `navigate.nodeId`, without which the plan's own *Go to Today* is
inexpressible, since it must run `ensure_date_node` and navigate to the id that
command returns through `focus` (`core.ts:2774-2776`, `CommandPalette.tsx:83-86`).
A missing or invalid binding at use is an executor failure
(`{ kind: 'bindingUnresolved' }`), not undefined behaviour.

PR 1 therefore carries a **compile-time negative fixture** — wrong args for a
command, `bindAs` on a non-bindable step, a step ref in a field that does not accept
one, each expected to fail type-checking — alongside a runtime
`ensure_date_node → navigate(bound focus node)` test. Without those the phrase "the
compiler decides" is decoration.

**Parameter** is what makes half the set expressible at all: *Move to* needs a
destination, *Add tag* a tag.

**Both need a query transport, not just a spec.** A static `ParameterSpec` cannot
express query-dependent behaviour, and the launcher has no projection to compute it
locally: `interactions/tagSelector.ts` needs a full `DocumentIndex`, the live query
and the already-applied tag ids, and it owns empty-query ordering, exclusion, the
hex penalty and the **dynamic Create row**. Shipping every tag inside a presentation
would be unbounded and stale within a keystroke.

So the pure tag policy moves to core beside the retrieval kernel, and main exposes
**one parameter-candidate query keyed by the authoritative invocation ref**:

```ts
// main: parameter/query { invocationRef, actionId, requestId, query } → candidates
type ParameterCandidates =
  | { kind: 'node'; items: readonly NodeCandidate[] }   // Move to (D5)
  | { kind: 'tag';  items: readonly TagCandidate[] };   // incl. the dynamic Create row
```

Same async contract as D5 — request identity, out-of-order responses dropped,
cancellation on close — and a parity test against the existing selector so the
policy is provably unchanged. Without this transport `Add tag` would also be absent
out of app, which the inventory in D1 does not claim.

### D1b — Admission: a renderer may name an action, never author one

The previous revision said the panel "returns the chosen effect" and main performs
it. Taken literally that makes the locked-down launcher renderer a **generic
mutation client**: submit `{ kind: 'command', … }` with fabricated operands and the
document changes. That is an A2/A3/A4 violation and it was the sharpest finding
across both reviews.

The shipped code already demonstrates the correct pattern:
`launcher:createContextCapture` accepts only an optional note while **main holds
the authoritative `ExternalContext`**, and the intent is validated at the seam
before it reaches durable storage. The registry follows it exactly:

0. **The ref has to be created before anything can name it, and that is the
   security boundary.** Main cannot infer which visual row was right-clicked, the
   live selection, panel identity, `rowExpanded` or `isPinned` from the projection —
   those are renderer facts today (`NodeContextMenu.tsx:63-80`,
   `OutlinerItem.tsx:2500-2516`). But letting a renderer post a finished
   `ActionInvocation` would let it author the very fields main is supposed to
   attest. So the main renderer sends an **`InvocationSeed`** — raw facts only, on a
   **sender-checked** channel — and **main** validates the ids, resolves reference
   targets and selection roots, and mints `origin`, `attestation`, lifetime and
   consumer. Page / node-search / app invocations are **constructed inside main** and
   never arrive over IPC at all. The launcher can neither submit a seed nor upgrade
   one; wrong-sender and forged-selection/`workspace` attempts are rejected, and
   both are tested.
1. Main returns `{ invocationRef, presentations }`.
2. The user picks → the renderer sends an `ActionRequest`: **action id, invocation
   ref, typed parameter**. Nothing else.
3. **Main re-evaluates** that action against the *latest* projection and its own
   invocation record, then produces and executes the effect itself.

So `ActionEffect` only ever travels **main → renderer**, which is the trusted
direction. A stale or forged request fails re-evaluation instead of mutating.

**`InvocationRef` needs an origin, a per-part attestation, and a phase — or the rule
above is not implementable.** In the command-surface path the renderer that *sends*
the request is always the launcher; the main renderer only *pushed the context*
(D4). So "the invoking surface is the main renderer" cannot key off `event.sender`:
that makes the toolbar permanently absent from the searchable surface, while letting
the launcher supply `workspace` erases the fence.

**Most invocations are main-origin, and an earlier draft could not represent them.**
Out of app, main captures the page and owns its `ExternalContext`, main returns the
node matches, and the empty launcher offers app-scoped navigation with no
renderer-supplied operand at all — and the main renderer may not even exist, since
its macOS window can be closed while the prewarmed launcher and the global hotkey
live on. Requiring `attestedBy: 'mainRenderer'` on every record would have forced a
choice between inventing provenance and deleting the plan's headline surface.

So provenance attaches to the **parts that need it**, not to the envelope:

- **`origin: 'main' | 'mainRenderer'`** — main-origin records are first-class.
- **`attestation`** — present *iff* the envelope carries `panel` or `workspace`,
  minted from a **sender-checked main-renderer IPC**, and carrying
  `webContentsId` + `renderGeneration` so a **reload invalidates it** rather than
  leaving a stale bit admissible. The launcher can never supply or upgrade these
  parts; an attempt is rejected, not merged.
- **`consumableBy`** — main hands a launcher-consumable ref to the *current*
  opening. Submitting against a ref you were not handed fails.

Admission then reads: an action needing `panel`/`workspace` requires a **current**
attestation; an action needing only anchor / page / app facts requires none. The
toolbar exception therefore holds in the searchable surface **iff** the main
renderer attested the bit — and *Go to Today* works with no main window at all.

**Phases are atomic, because "single-use" was not exclusion.** A record with only
identity and expiry lets two concurrent requests both observe it live and both
dispatch, and lets two challenge-less requests each mint their own individually
single-use token — so *Duplicate*, *Move*, or create-and-apply could run twice. The
renderer's `runningRef` is not an admission boundary, least of all under the
compromised-launcher threat model. Main therefore owns a phase machine:

Every transition has a named event, because a diagram with an unreachable arrow is
worse than no diagram. **Confirmation has two flows and they must not share rows** —
one is renderer-driven, the other exists precisely because a renderer cannot be
trusted with it.

**Flow A — renderer-dialog confirmation.** Every confirmed action in PR 1, and
reversible confirmations thereafter.

| from | event | to |
|---|---|---|
| `live` | request, action has no `confirm` | `executing` |
| `live` | request, action has `confirm` | `confirming` — mints **the one** challenge and returns it |
| `confirming` | **the challenge-bearing request — this *is* acceptance** | `executing`, atomically, after token + operand validation |
| `confirming` | `confirmationCancelled` | `live` — challenge revoked in the same atomic step |
| `confirming` | challenge TTL expiry | `live` — challenge revoked |
| `confirming` | operand mismatch on redemption | `live` — challenge revoked, presentation re-issued |

There is deliberately **no separate "accepted" event**: the accepting request is the
acceptance. An earlier draft split them, which made the normal path unreachable —
the record sat in `confirming` while redemption demanded a phase nothing could enter.

**Flow B — native confirmation** (PR 2; the two actions outside `Cmd+Z`).

| from | event | to |
|---|---|---|
| `live` | request, `confirm` is native | `confirming` — **no token minted and none exposed**; main raises its own sheet |
| `confirming` | **main's own sheet acceptance** — not a renderer message | `executing` |
| `confirming` | sheet cancelled or dismissed | `live` |

**No renderer-supplied "accepted" event exists for this flow**, because one would
recreate exactly the consent bypass the sheet exists to prevent. A launcher attempt
to advance a native confirmation is rejected, not merged. Main revalidates operands
at acceptance, the same as flow A.

This is also why `readyToCommit` is gone: both flows commit straight from
`confirming` — flow A on the redeeming request, flow B on main's own acceptance —
so a fourth phase existed only to be transited through.

**Shared rows, both flows:**

| from | event | to |
|---|---|---|
| any phase before `executing` | `abandoned`, chip removal, dismissal, superseding open, attesting-renderer reload, invocation TTL | `spent` (terminal) |
| `executing` | settlement — `completed` / `failed` / `indeterminate` | `spent` |
| `executing` | dismissal · superseding open · reload | **`executing`** — UI lifetime events must never invalidate an in-flight plan |

The invocation is **claimed on entering `executing`, before step 0 is dispatched** —
not at completion. A second submit against a claimed record is rejected.

**PR 1 has to wire the cancel event, and it is not a behaviour change.** The shipped
`ConfirmDialog` routes Cancel, Escape and backdrop to `onCancel`
(`ConfirmDialog.tsx:38-57`), and the menu's handler only clears local state
(`NodeContextMenu.tsx:589-597`) — main never learns. It now also emits
`confirmationCancelled`. Nothing the user sees changes, so the strict differential
proof still holds; what changes is that the record returns to `live` and the
challenge dies with it.

**Chip removal is a real invalidation, not a local erase.** D4 lets the user drop an
operand; without an `abandoned` event the old ref stays admissible with its original
operand set — exactly the substitution the challenge binding exists to prevent.

**Every explicit dismiss path is phase-aware.** Today Esc goes straight to
`launcher.hide()` (`LauncherApp.tsx:170-175`) and every hide bumps `launcherOpenSeq`
(`main.ts:1585-1595`) — which, mid-plan, would either invalidate the ref between two
steps or destroy the only surface that was going to report the outcome. So while a
record is `executing`, Esc and the global toggle **mark dismiss-after-settlement**
rather than hiding, alongside the blur guard that is already armed. Before
`executing`, they invalidate and hide as they do today.

Tests: two simultaneous submits, two simultaneous first-leg confirmations, Esc and
global-hotkey dismissal while step 0 is pending, dismissal between two steps,
**cancel then run a different action from the same menu opening**, **redeem after
cancel**, **redeem after challenge expiry**, **submit through a ref whose chip was
removed**, **PR 1 Confirm-to-effect end to end**, **native Cancel with no token ever
minted**, **a launcher attempt to advance a native confirmation** (rejected), spent-ref replay, wrong sender, superseded open, a launcher attempt to add
`panel`/`workspace`, attestation invalidated by a main-renderer reload, and a global
app action plus a node-result action **with the main window closed**.

**Two admissions for renderer-owned facts, both bounded.**

**(a) Renderer-side effects.** Facts main cannot know — `isPinned` is localStorage
workspace chrome (`useWorkspacePinnedNodes.ts`) — may be renderer-supplied when the
resulting steps are also renderer-side (`workspace`, `reveal`, `clipboard`). Pin
cannot corrupt the document because pinning never touches it.

**(b) One named parameter to one command.** The toolbar toggle genuinely needs
`rowExpanded` to decide *whether the document changes at all* (see D1's table), so
"a command resolves entirely from main-owned state" cannot hold universally without
changing behaviour. Rather than bend the rule silently, it is **listed by name and
fenced by three conditions, all of which must hold**:

1. the `workspace` facts were **attested by the main renderer** — which is not the
   same as "the main renderer sent this request" (see the provenance rule below);
2. the parameter selects among **view preferences the user can immediately
   re-toggle** — never node identity, never operand membership, never destructive;
3. it is **enumerated in the registry**, not admitted by category.

`rowExpanded` → `set_view_toolbar_visible` is the **only** entry that qualifies
today. The rule this protects is "a compromised locked-down renderer must not
author arbitrary mutations", and a main-renderer-only toggle of one view preference
is not that. Any future entrant is a plan-level decision, not an implementation one.

**Confirmation is a main-owned phase, not a boolean a caller can assert.** A
`confirmed: true` field would be convention: nothing stops a caller from setting it
on its *first* request, so main would have no evidence a confirmation happened at
all — and the threat model right above explicitly includes a compromised launcher
renderer, which could then name *Delete forever* and assert it.

**Flow A (renderer dialog) has two legs and main owns both:**

1. A request **without** a challenge for an action carrying `confirm` responds
   `{ status: 'confirmationRequired', challenge, confirm, presentation }` — the
   token is **single-use, short-lived, and bound to
   `(actionId, invocationRef, hash(resolved operands))`**, and the response carries
   the authoritative copy and operand set the dialog must show, so the dialog cannot
   describe one thing while the token authorises another. This is why
   `ActionRequestResult` is a union: the first leg is a *response*, and a contract
   with only inbound requests and terminal outcomes had no way to carry it across
   preload/IPC.
2. **The challenge-bearing request is the acceptance**, and it commits atomically.
   Main revalidates: token unspent and unexpired, the record in **`confirming`**,
   and **the operands re-resolve to the same set** — so a dialog shown for three
   nodes cannot commit against thirty. Any failure revokes the challenge and returns
   the record to `live`.

**The security claim for flow A is stated exactly, because a challenge alone does
not prove a human saw anything.** A compromised renderer that *receives* a challenge
can redeem it silently. The challenge closes first-request commits, replay, and
operand substitution between the legs — not "the user consented".

**Flow B (native) exists because that is not enough for the two actions outside
`Cmd+Z`** — *Delete forever* and *Empty Trash* — once a second, locked-down renderer
can name them. It is **not flow A with a different dialog**: it has **no legs and no
token**.

Main raises the sheet (`dialog.showMessageBox`), and **main's accepted sheet
revalidates the operands and atomically claims `confirming → executing` without ever
creating a `ChallengeToken`.** Nothing is minted, so nothing can be handed to a
renderer, so nothing can be redeemed by one — which is the whole point: a token
would put the deciding artefact back in the hands the sheet exists to bypass. Main
raises it, main observes the acceptance, main executes.

**That change lands with PR 2, not PR 1.** The context menu ships an in-app
`ConfirmDialog` today (`NodeContextMenu.tsx:589-598`), and replacing it with a
native sheet changes presentation, focus, keyboard behaviour and window modality —
which PR 1 cannot do while claiming zero behaviour change, and which its differential
proof could not verify (comparing "did a confirmation appear" is exactly the
weakening that would hide it). The timing is not a compromise either: **the threat
that motivates the native dialog is a compromised launcher renderer, and the
launcher path arrives in PR 2.** So PR 1 keeps the shipped dialog and the challenge
protocol behind it; PR 2 introduces the native dialog for the two irreversible
actions in both views, as a **declared user-visible change** with light/dark and
focus/keyboard verification. *Delete forever* and *Empty Trash* are outside
`Cmd+Z`'s reach — which is why they were given a dialog, and why D9's
fire-to-commit rule applies only *after* this point.

**`confirm` is a first-class field because deletion already demands one.**
*Delete forever* and *Empty Trash* route through `ConfirmDialog` today
(`NodeContextMenu.tsx:280-296`) and `spec/commands.md` requires it. D9's
fire-to-commit rule cannot silently swallow that, so the contract is: **an action
carrying `confirm` produces no effect until confirmation resolves**, and D2's
equivalence proof compares the *interaction* — did a confirmation appear — not only
the command that eventually ran.

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
menu.render(registry.byScope('node', 'selection', 'panel').filter(a => a.operands(ctx).length > 0))
```

The context menu accepts `node`, `selection`, **and `panel`** — it is rendered
*inside* a panel, and it already carries panel-scoped items (*View as*,
*Filter / Sort / Group / Display*, *Show view toolbar*). An earlier draft of this
rule accepted only node and selection, which would have silently dropped those
from the menu and failed the equivalence criterion below. It does **not** accept
`app`: Go to Today does not belong on a right-click. The command surface accepts
every scope.

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
  deleted. The launcher already covers most of it (node search, open in the main
  window, new node in Today) but **is not yet a superset**: the palette also carries
  five navigation destinations and shows them as its empty-query list
  (`CommandPalette.tsx:102-143`), which the launcher explicitly defers
  (`core/launcher/commands.ts:83-85`). The launcher *becomes* a superset at stages
  3 and 5 — deleting the palette before then would lose behaviour.
- **Navigation destinations become registry entries** (`scope: 'app'`): Go to
  Today / Library / Schema / Saved searches / Trash. They are already implemented,
  so they cost nothing — and a surface that claims to be the universal entry point
  cannot be missing the app's own destinations. ("The sidebar shows them anyway" is
  not a reason to omit them: by that logic the context menu would justify omitting
  every node action.)
- **Two navigation semantics must be carried over, not re-invented.** The palette's
  Today row runs `ensureTodayNode` **before** navigating — it creates the day's node
  when missing (`workspace-layout.md`: "the in-app command palette uses the same
  ensure-first path"), so a `Go to Today` entry that only navigates is a regression.
  And in-app navigation re-roots the *active panel in place*, while the launcher's
  path routes through main; the registry entry must resolve to the in-place one when
  a panel exists.
- **In-app summon must not read external context.** Today the hotkey classifies
  Tenon itself as `unknown-app`; when the main window is frontmost, skip the
  external capture and attach in-app context instead (D4).
- **Focus lands where the action points.** A navigation action leaves focus at its
  destination — that is what navigating means. Every other action returns focus to
  the editor
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

### D5 — One matching kernel; typed candidate policies stay with their domain

**What converges is the matching kernel, not the candidate policy.** The at-caret
paths are not naive duplicates of node search — they carry domain rules that must
survive: `@` candidates admit synthetic `date` and `create` rows, reject
tree-references, and boost siblings/ancestors (`referenceCandidates.ts`); `#`
candidates admit tags only, exclude tags already applied, and penalise hex-looking
strings (`tagSelector.ts`). `nodeRetrievalService` exposes generic options (limit,
search node, personal-access) and knows none of that. Replacing those paths with it
wholesale would be a regression dressed as convergence.

So: **one text-matching and ranking kernel; typed candidate policies stay with
their domain.** What is eliminated is a *second implementation of matching* — and
*Move to*'s complete absence of one. **The at-caret paths are not migrated by this
plan at all**; doing so later owes measured latency plus cancellation and
out-of-order-response tests under A9, which is different work from fixing a broken
picker.

**`Move to` needs a typed candidate policy, applied before limiting.** Its picker
is not generic search with a filter bolted on: it excludes the moving nodes, field
entries, descendants of the moving nodes, and Trash — **and it lists valid
candidates on an empty query**, which `searchText('')` does not
(`nodeRetrievalService.ts:14-58`). Two consequences the naive migration gets wrong:

- **Admission runs before the limit, never after.** Filtering a limited generic
  result would let invalid descendants consume the limit and hide a valid ranked
  destination — preserving the exact defect this fixes.
- **Empty query has its own ordering**, not "no results".

```ts
interface MoveToCandidatePolicy {
  admits(candidate: NodeProjection, moving: readonly NodeId[]): boolean;
  emptyQueryOrder(ctx: ActionContext): readonly NodeId[];
}
```

**It goes through main over IPC.** An earlier revision kept it renderer-local
because "the renderer already holds `byId`" — which is true and irrelevant.
`NodeRetrievalService.searchText` always supplies the live `TextSearchIndex`
(`nodeRetrievalService.ts:46-58`), and **without that index `searchEngine`
deliberately falls back to a different whole-phrase scorer**
(`searchEngine.ts:1297-1330`). The renderer's `DocumentIndex` is
`{ projection, byId, renderRev?, dayNoteCounts }` — **no text index**
(`state/document.ts:38-61`). So renderer-local would have given the *fallback*
ranker, and the difference is observable, not theoretical: the indexed path matches
`launch design` against a node titled `Design review` with description `Launch
notes`, which whole-phrase scoring cannot. Choosing local was optimising PR size
over the fix actually working.

The async burden that avoided is real but **already solved next door** — the
launcher's shipped 120 ms debounce plus stale-response suppression
(`LauncherApp.tsx:74-96`) is the pattern to reuse, not reinvent. PR 1 therefore
carries, for this path:

- **debounce** on keystrokes;
- **request identity**, with out-of-order responses dropped;
- **cancellation** when the menu closes or the mode changes;
- an A9 measurement, since this is a new per-keystroke IPC consumer.

**Admission runs in main, before the limit** — main holds both the projection and
the index, so `MoveToCandidatePolicy` filters and *then* the result is limited.
This is the whole point: filtering after the limit lets invalid descendants consume
it and hide a valid ranked destination.

So the invariant is **identical ordering for identical options and the same policy**
— and `Move to` now genuinely has the same kernel to be identical *to*.

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
- an operand chip but no query → the chip's applicable actions are the rows, and
  **the first one is always non-mutating** (Open / Go to). D6's own rationale
  demands it: this is the position a blind Enter lands on, so it must never be a
  document change. Registry ordering, not chance, guarantees it;
- **no chip, no query** → the rows are the `app`-scoped entries (the navigation
  destinations) — never a blank panel. Highlight the first.
- otherwise → the first search result.

**Recents were considered and dropped.** The superseded plan carried "persist the
last N capture/jump targets, surface as empty-query quick rows" as a must-keep
contract. It is not carried here: with capture landing in Today (D9) there is no
destination to remember, and the empty state now has real content (navigation
entries) rather than needing filler. Recency already earns its keep where it
belongs — inside search ranking (`nodeAccessStore`). Recording the drop so it is a
decision, not an omission; re-adding it later is a registry entry, which is the
point.

Rationale for keeping it fixed: a user who types-and-blindly-Enters always exists.
Putting a document-mutating action under a blind Enter buys one saved arrow key and
costs the habit of blind-Enter entirely the first time it surprises them.

### D7 — Hidden without an operand; shown with a reason when a predicate fails

Pure `when`-clause hiding (the VS Code model) has a dead end in a *searchable*
list: you type "move", get nothing, and cannot tell whether the action does not
exist or merely does not apply right now. VS Code survives that because its command
names come from documentation; this action set is learned by exploration. So two
tiers:

- **`status: 'absent'`** — no operand at all (empty query, no chip, no selection) →
  **hidden**. Opening the surface must not present a screen of things that cannot
  run.
- **`status: 'rejected'`** — an operand exists but a predicate refuses it → shown
  **with its `reason`** ("Move to — unavailable in Trash"), not silently dropped. A
  reason teaches the rule; a disappearance teaches distrust.

These are the two non-applicable states of `ActionEvaluation` (D1a). They exist as
distinct variants *because of this rule*: a single empty operand list collapses them
and carries no reason.

The context-menu view keeps its current behaviour under the same rule, since it
always has an operand. Inside the command surface the tiers apply to the `⌘K`
action list for the highlighted row; the flat result list itself is never padded
with rejected actions.

### D8 — Action naming is part of the contract

In a menu, position and icon carry meaning; in a searchable list only the name
does. Every registry entry gets a reviewed, searchable name in **both** locales
(`spec/i18n.md`). Names are reviewed as a set, not one at a time.

**Search matches both locales at once, regardless of UI language.** This user
thinks in English command names and runs a Chinese interface; a surface that only
matches the active locale's string would swallow half of what they type. The
locale-independent `id` and both display names are all matchable — the pattern
`filterSlashCommands` already uses (English label + keywords as a locale-independent
base, plus the localized label).

### D9 — Every panel-fired action reports its result; capture closes its loop

**The general rule first:** the panel does not activate the main window and
dismisses itself when an action runs, so **any** action fired from it must return a
visible result signal. "Move X into Y" from the panel has exactly the same problem
as a capture — the surface vanishes and the user may not be looking at the window
where it landed. One rule, not a capture special case.

**One window lifecycle, because two earlier decisions contradicted each other.**
"Focus returns immediately" plus "confirm inside the panel" cannot both hold: the
launcher routes `blur` straight to `dismissLauncher()`
(`launcherWindow.ts:108-114`), so returning focus at commit destroys the very
surface meant to show the confirmation — precisely in the background case the
signal exists for. The lifecycle is therefore explicit:

1. **Before step 0 is dispatched**, the panel enters an **executing** state and main
   arms a **main-owned blur guard**. Arming it after the first step commits was a
   race with two ways to lose: step 0 itself can fail (a command can throw, a
   renderer step can never acknowledge), leaving no committed step to enter the
   state *from*; and any destination step that focuses the main window would trip
   the launcher's shipped `blur → dismissLauncher()` handler
   (`launcherWindow.ts:108-114`) and destroy the panel before its outcome could be
   rendered. The guard is main-owned because that handler is.
2. The guard is **held through settlement**, then the panel shows the outcome for a
   bounded dwell.

**Delivery has two bounded phases and a third outcome, because a missing ack is not
evidence of failure.** The main renderer can perform `openSplitPane`, navigate, pin
or stage the composer and *then* reload before its ack reaches main; calling that
`failed` would be a lie, and a retry could duplicate a visible effect. So:

- **Readiness** is bounded. A step for a not-yet-loaded renderer queues on
  `did-finish-load` (the shipped `LAUNCHER_NAVIGATE_TO_NODE_CHANNEL` pattern), but
  the queue entry is **keyed by `executionId` and cancelled on expiry**, so timed-out
  work can never apply later. Expiring here yields `failed { notDelivered }` —
  main knows it never left.
- **Post-delivery acknowledgement** is bounded separately. Expiring here yields
  **`indeterminate { ackTimeout }`**, never `failed`.
- Every dispatched step carries **`executionId + stepIndex`**, and the renderer
  **dedupes on it**, so a redelivered step is a no-op rather than a second effect.

`indeterminate` has its own honest treatment: the dwell says the action **may have
completed**, focus goes to the **invoker** (the safe default when no arrival is
proven), and **nothing retries automatically** — a retry is a fresh invocation the
user starts, because only the user can see whether it happened.
3. At the end of the dwell the panel dismisses **itself**, and **focus goes where
   the action's `completion` policy says** — never unconditionally back to the
   invoker. **Focus moves at dismissal, not at commit.**
4. Esc during the dwell ends the dwell early. It never cancels the action —
   reversal is `Cmd+Z`, the same undo as everywhere else.

**`completion` is per action, because "restore the invoker" destroys half of
them.** A blanket restore means *Go to node* from another app raises Tenon and then
hands focus straight back to that app, and *Send to the agent panel* reveals the
composer only for dismissal to take the user away from it — the two actions whose
entire purpose is to move you somewhere.

- `restoreInvoker` — mutations, clipboard, capture. You stay where you were; the
  dwell tells you it happened.
- `stayAtDestination` — navigation and composer handoff. Tenon keeps focus at the
  destination, and **the result signal is not needed** (arrival is its own
  confirmation), so the dwell is skipped and the panel dismisses at once.

**`completion` applies only to `{ status: 'completed' }`. Failure has its own
lifecycle** — without this, a `stayAtDestination` action whose main-renderer ack
comes back failed would dismiss instantly, show nothing, and leave the user in
neither focus state, contradicting D9's own rule that every panel-fired action
reports its outcome. On `{ status: 'failed' }`, regardless of `completion`:

- the panel **stays** for the dwell and shows the failure reason from
  `ActionExecutionResult`;
- focus goes to the **invoker**, because no destination was proven reached — a
  failed *or indeterminate* navigation must not strand the user somewhere neither
  surface promised;
- E2E covers, alongside the three success shapes: a **step-0 main command failure**
  (nothing committed, guard still armed, reason shown), an **explicit failed renderer
  ack**, a **missing ack that hits the timeout** (reported `indeterminate`, not
  `failed`), **effect applied then renderer reloads before acking** (also
  `indeterminate`; the effect must not be undone or repeated), a **closed or still
  loading main window** (queued, then cancelled on expiry — and the cancelled item
  must not apply afterwards), and the **blur ordering** — a destination step focuses
  the main window and the panel must still survive to render its outcome.

E2E covers all three shapes: a background mutation (dwell visible for its duration,
prior app refocused, in that order), `Go to node` from another app (Tenon focused at
the destination, invoker **not** restored), and composer handoff from another app
(rail revealed, focus in the composer).

**"Once the effect exists" is doing real work in that sentence.** An action
carrying `confirm` (D1) produces no effect until confirmation resolves, so
fire-to-commit applies *after* the confirmation, not instead of it. *Delete
forever* and *Empty Trash* keep their dialog in both views — they are outside
`Cmd+Z`'s reach, which is exactly why they were given one.

- **Destination is Today.** No picker, no Inbox.
- **Success is visible.** Capture currently resets and hides with no confirmation
  (`LauncherApp.tsx:121-127`) — when Tenon is in the background the user gets no
  evidence at all. Show a brief confirmation before dismissing.
- **One optional user tag at capture time.** Findability comes from tags and
  search, not from location. (The capture-kind tag `#article`/`#video` → `#capture`
  already exists; what is missing is *the user's own* tag.)
- **"Send to the agent panel" is a registry action, not a new AI surface.** It
  raises the main window, reveals the rail, and stages the operand *and the text
  already typed in the panel* — the user edits and submits. Carrying the typed
  query is not a nicety: dropping it would mean the one entry point that works from
  outside the app silently discards what the user wrote.

  **A foreground page is context, not a user message** (PM, 2026-08-03). A node
  operand is already expressible as a `nodeReference`, but an external page is not
  one of `ThreadUserContent`'s three kinds (`text` / `attachment` / `nodeReference`)
  — and it should not become one. It enters through the channel the runtime already
  has for exactly this: a renderer-supplied **`additionalContext` entry**, rendered
  inside `<system-reminder><context-evidence>` by `ContextProjector.ts:742-749`,
  under the `additionalContext` evidence kind.

  Three properties make this the right channel rather than a workaround:

  - **No protocol change.** `RendererTurnStartRequest.additionalContext` already
    exists (`protocol.ts:1271`), so this plan stays a *consumer* of
    `agent-data-model`'s contract and does not edit an authority file.
  - **Untrusted by construction.** That field's type forces every renderer-supplied
    entry to `kind: 'untrusted'`. Web page text can therefore never arrive with
    application authority, which is precisely the injection risk a page-as-user-text
    design would have created. The stable prompt already states the rule: authority
    comes from host metadata, never from tag spelling.
  - **Precedent.** `AutomationDispatcher.ts:128` already injects non-user-authored
    context this way.

  So: the page becomes an untrusted `additionalContext` entry (URL + title, plus
  reader text later if the static reader lands), the user's typed text is the actual
  user message, and the agent can tell the two apart. Capture-into-a-node-first was
  considered and rejected — asking a question should not silently create a node.
- **The handoff needs a new leg *and* a new composer concept.** Three separate
  gaps, none of which the existing code covers:
  - `agent/agentReveal.ts` is renderer-local pub/sub queueing `{ nodeId, title }`
    only — no IPC, no window raise, and its only caller already lives in the main
    window. The panel path adds a cross-process hop, a window raise, and
    queue-until-loaded, reusing the `LAUNCHER_NAVIGATE_TO_NODE_CHANNEL`
    flush-on-`did-finish-load` shape rather than a second mechanism.
  - `ThreadView.onSend` accepts `ThreadUserContent[]` and `ThreadStore.send`
    forwards content plus user-view hints — **neither carries
    `additionalContext`**, so a page staged today would be dropped at submit.
  - Nothing owns staged-but-unsent context.

  **`PendingComposerContext`** closes all three. It is **bound to one Thread**,
  **visible**, and **removable** — never invisible sticky state. Its semantics are
  part of the contract, not implementation detail: a second handoff **replaces**
  rather than accumulates; switching Threads leaves it with the Thread it was
  staged on; it is **consumed when a turn is accepted**, and **restored** if the
  send fails. It passes through `ThreadView` and `ThreadStore` on both `turn/start`
  and steer. Proven by an E2E asserting the user's text and the untrusted page
  context reach **exactly one** turn.

### D10 — Out-of-app fidelity chain

Structured read (AX browser tab) → URL + title → *clipboard* → manual entry. No
screenshot tier. Read nothing → no chip, degrade to a plain note. Per A12 this
path degrades; it never throws on the user's action.

**The clipboard tier does not exist and this PR does not build it.** There is no
clipboard read anywhere under `src/main/context/`, and no stage below adds one — so
it is named here as the intended shape and marked **deferred**, not described as
present. Today the chain is structured read → URL + title → manual entry, and it
degrades correctly without the middle tier.

## Shape and build order

**Shape (b): two independent complete features**, split at the **proof boundary**
rather than by feature. Each is useful and verifiable alone; PR 2 depends on PR 1
only because it builds on a foundation PR 1 has already proven.

### PR 1 — the context menu becomes a view of a core registry

Zero behaviour change, mechanically proven, plus one bug fix. **The confirmation UI
is not touched here** — the shipped `ConfirmDialog` stays, and the native sheet
lands with PR 2, whose threat model is what motivates it (D1b). A PR that claims a
strict differential proof cannot also swap a dialog.

1. **Contracts in `src/core/actions/`** (D1a) as compiling TypeScript with codec
   tests — invocation, evaluation, presentation, request, effect — and the
   main-owned admission path (D1b).
2. **Predicates move to core** (D1). The stage-0 spike, done before approval,
   found no renderer dependency that survives tracing: `rowMap` is a cache with an
   existing derivation fallback, `actionPolicy` derives from the projection, and
   `panelRootId` is read by exactly one predicate.
3. **Populate the registry with the entire existing node-menu action set.** This is
   the point of PR 1: the compiler, not a document, decides whether the contracts
   can express *Pin* (workspace chrome), *Copy* (clipboard), *View as* (panel),
   *Delete forever* (confirmation) and *Move to* (parameter).
4. **Re-render the context menu as a registry view**, differentially proven against
   the old path (D2), which stays in the tree as the oracle until the last commit.
5. **Fix the `Move to` picker** — route it through the shared retrieval kernel
   (D5). The one user-visible win in this PR, and it lives in the same file.

**Why this is a complete feature and not groundwork.** It has a real consumer (the
context menu), a mechanical proof (differential vs the old path), and it ships a
bug fix a user meets immediately: *Move to* currently slices ten matches in
document order with no ranking, so a target can simply fail to appear. It is the
`#451` pattern — freeze the observable surface, prove it unchanged, build on it —
which carried a 4,700-line move to zero review findings.

**It also touches no agent or composer file**, so it does not collide with #486.

### PR 2 — the command surface and the capture loop

6. Render the registry as the command surface's searchable view: rows into the
   existing ordering, `Actions ⌘K` into the existing action bar and the action list
   behind it (D6), in-app invocation path and aggregate chip (D4), focus return and
   result signal (D9).
7. Capture loop: confirmation, optional tag, send-to-agent action with its
   `PendingComposerContext` (D9).
7b. **Declared user-visible change:** replace the in-app `ConfirmDialog` with a
   main-owned native sheet for *Delete forever* and *Empty Trash* in **both** views
   (D1b). It belongs here rather than in PR 1 because the threat it answers — a
   locked-down renderer naming an action that `Cmd+Z` cannot reach — arrives with
   this PR. Verified light + dark, with focus and keyboard behaviour.
8. Delete `CommandPalette.tsx`, the global `Cmd+K` binding (`shortcutRegistry.ts:139`
   — the keystroke lives on inside the panel as *Actions*), and the stale `/`-menu
   hint. **The old menu oracle is not deleted here — PR 1's final step already
   removed it** once equivalence was proven.

**Sequenced after #486 merges**, since step 7 touches `ThreadView` / `ThreadDock` /
both locale files.

### Why the split moved here

The PM originally chose one PR to spend one ratification and one merge. Two full
review rounds later that PR had produced zero code, so the bandwidth argument had
been answered by events. Both NO-GOs had the same root cause — **a type asserted in
prose cannot be falsified**, so each round fixed the prose and the next round found
the next thing prose could not hold. The split puts the contracts where a compiler
and a differential test can judge them instead.

## Verification

- **Menu equivalence (PR 1, step 4).** Differential: the old menu path is the
  oracle and both paths render over a corpus of real document states; outputs must
  be equal, **including effect-step order and failure behaviour** (D1a).
  Cousin of #445's golden Item-stream parity — compare against the real thing, do
  not hand-enumerate the states that matter.
- **Retrieval convergence (PR 1, step 5) — scoped to the node-picker consumers this
  plan ships.** The assertion covers `Move to` and the command surface, not every
  entry point: the at-caret paths deliberately keep `candidateRanking.ts`, whose
  label-rank tiers are not the main search-engine rank, so a global "identical
  ordering everywhere" test could never pass and should not be written (D5).
  Separately tested: `MoveToCandidatePolicy` **admits before limiting** (a corpus
  where invalid descendants would otherwise consume the limit and hide a valid
  destination), and its **empty-query ordering** returns candidates rather than
  nothing.
- **Scope filtering (D2).** Assert no `app`-scoped action reaches the context menu
  (the failure mode the navigation entries introduce) and that every `panel`-scoped
  menu item still does.
- **Contract correlation (D1a), the reason these types live in PR 1 at all.** A
  compile-time **negative** fixture: wrong args for a command, `bindAs` on a
  non-bindable step, and a step ref in a field that does not accept one must each
  **fail** type-checking. Plus a runtime `ensure_date_node → navigate(bound focus
  node)` proving *Go to Today* is expressible, and a `bindingUnresolved` case.
- **Lifecycle round-trip (D1b).** The actual response sequence, not just the phases:
  request → `confirmationRequired` + challenge → dialog → challenge-bearing request →
  execution result. Plus wrong-sender and forged-seed rejection at invocation
  creation.
- **Confirmation parity (D1 `confirm`).** In PR 1 the assertion is **strict**: the
  shipped `ConfirmDialog` still appears, with the same copy and the same operand
  set, and no effect exists before it resolves — no weakening to "some confirmation
  appeared", which is what would have hidden a swapped dialog. PR 2 replaces it with
  the native sheet for the two irreversible actions and re-verifies focus and
  keyboard behaviour in both themes.
- **Applicability (D7).** Property test: every rendered action either applies, or
  is rendered with its rejection reason. Nothing silently inapplicable.
- **Action result signal (D9).** E2E: fire a mutating action from the panel with
  the main window in the background; assert the user gets a result signal.
- **Capture (D9).** E2E: capture with a tag from a background app, assert the node,
  the tag, and the confirmation.
- Light + dark visual verification (UI diff); `typecheck`, `test:core`,
  `test:renderer`, `test:e2e`, `docs:check`.

## Open questions

None open. Four were settled before approval rather than deferred, because each
changes a contract or a user-visible behaviour rather than a private helper — the
`commands.ts` shape (D1a: bound references, compound command closed, no
interface-first PR) and the `Move to` retrieval path (D5: IPC through main, with
debounce, request identity, cancellation and an A9 measurement) joined the two
below:

- **Icons: registry entries carry an `iconId`; each view resolves it.** The
  launcher keeps `launcherIcons.tsx` as its own resolver so the locked-down bundle
  never pulls the renderer's full `icons.ts` — the bundle split is deliberate
  (`icon-semantics.md` records it as the one sanctioned lucide import outside the
  renderer). Ids are locale- and bundle-independent, so a view that lacks a glyph
  falls back rather than failing.
- **Result signal: a brief in-panel confirmation before dismissal**, delivered
  through the result state in D9 (which suppresses blur-dismiss for the dwell —
  without that, focus return would dismiss the panel and take the confirmation with
  it). Chosen by elimination: an OS notification needs a permission grant and is
  easy to miss; a main-window surface is invisible exactly when it is needed, since
  the motivating case is Tenon sitting in the background. The panel is the one
  thing the user is looking at and needs no permission.

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
  backend, reached through the explicit `ExplicitPageReader` entry point, **never**
  through the ambient `PageContentExtractor` seam (see Non-goals). That plan's open
  question ("is the static reader still valuable beside the hardened preview?") is
  answered yes by this decision: it has a second consumer.
- `browser-extension-integration.md` — record-only, and a **deferred second
  extraction source** (JS-rendered / signed-in pages) behind the static reader. Its
  fallback-chain claim and its `PageContentExtractor` nomination were corrected in
  this change. One correction remains outstanding: **the filename says "extension"
  while its own non-goals exclude one**, and renaming breaks the `docs/TASKS.md`
  link, so it needs the main agent.
- `agent-conversation-model.md` / `agent-data-model.md` — authorities for the
  handoff content shape in D9.

## Collision self-check

Re-run at the start of each PR. As of 2026-08-03:

**PR 1 — no collision.** Touches `src/core/actions/` (new), the moved predicates
out of `src/renderer/ui/interactions/`, `src/renderer/ui/outliner/NodeContextMenu.tsx`,
and the main-side admission handler. **No agent, composer, launcher or locale
file**, which is what keeps it clear of #486.

**PR 2 — overlaps, re-derived 2026-08-04 with `gh pr list` + `gh api …/files
--paginate`.** (The `--paginate` matters: the default page returns 30 files, which
is why an earlier sweep read #483 as touching only `ThreadView`.)

**The snapshot below is evidence, not the contract — open PRs move.** (#483 and
#488 both advanced within the hour it was taken.) The binding instruction is the
*ordering*: PR 2 lands after both, and the inventory is re-derived at implementation
start.

| PR | Overlaps | Handling |
|---|---|---|
| [#486](https://github.com/relixiaobo/lin-outliner/pull/486) · [#487](https://github.com/relixiaobo/lin-outliner/pull/487) *(merged)* | composer files · both locales · `main.ts` | already in `main`; rebase |
| [#483](https://github.com/relixiaobo/lin-outliner/pull/483) *(open)* | **`ThreadView.tsx`**, **`ThreadDock.tsx`**, **`threadStore.ts`**, **`src/main/main.ts`** — the whole surface `PendingComposerContext` threads through | PR 2 lands **after** it and rebases; do not run in parallel |
| [#488](https://github.com/relixiaobo/lin-outliner/pull/488) *(open)* | **both locale catalogs**, **`src/main/main.ts`**, and **`src/core/types.ts`** (infrastructure-owned) | PR 2 lands **after** it; its `types.ts` edit is the one to watch, since neither of our PRs touches that file |
| [#489](https://github.com/relixiaobo/lin-outliner/pull/489) · [#480](https://github.com/relixiaobo/lin-outliner/pull/480) | none (docs / release tooling) | — |

**PR 1's exposure is smaller but not zero**: its main-side admission wiring lands in
`src/main/main.ts`, which #483 and #488 both touch. PR 1 rebases onto whichever
lands first; the conflict is additive rather than semantic.

PR 2 additionally touches `src/renderer/ui/CommandPalette.tsx` (deleted),
`src/renderer/launcher/*`, `src/main/launcher/*`,
`src/main/context/contextCapture.ts`, and the locale files.

**Neither `src/core/commands.ts` nor `src/core/types.ts` is touched**, and no
interface-first PR is required — settled in D1a rather than left to implementation.
(Three earlier drafts of this section were stale: naming #477 as the only open PR,
then calling #486 open after it merged, then recording only #486 while #483 and
#487 were already open — which is why this check
is re-derived from `gh pr list` at the start of each PR, never from memory.)

## Appendix — provenance

Why this shape rather than another. Kept so the settled boundaries are not
silently re-opened; not needed to build the design above.

### The evidence

The repository already contains the controlled experiment, one line right and one
line wrong:

| Action | Entry points | Shared | Not shared |
|---|---|---|---|
| Apply a tag | 3 (`#` trigger popover — which is `TagSelector`'s only renderer — node context menu, batch selector) | candidate list + ranking (`ui/interactions/tagSelector.ts`) | **apply**: three implementations (`TagSelector.tsx:41-50`, `BatchTagSelector.tsx:89-93`, `NodeContextMenu.tsx:250-258`) |
| Find a node | 4 | — | **three rankings** |

Read the tag row carefully, because it cuts the other way from how it was first
written: even the *good* example converged only at the ranking layer. Three
separate call sites still decide how a tag is applied. That is the pattern this
plan generalises — share the decision, not just the list.

The retrieval row: `NodeContextMenu.tsx:222-232` filters the whole projection with
`.includes()`, **no ranking at all**, then slices the first ten in document order;
`ui/interactions/candidateRanking.ts` ranks by text match;
`main/nodeRetrievalService.ts` ranks with the personal-access boost (#111, #307).
Note the command palette is **not** an outlier — `CommandPalette.tsx:63` already
calls `search_nodes` through the same main-side service as the launcher, so stage
1's real work is narrower than "four entry points" suggests: the *Move to* picker
and the at-caret candidates are the two that diverge.

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
observed") is **overwhelmingly** *bring the outside in*. The exceptions are a
conversion family (`Turn Note into Capture`, `Turn Capture into Task`, ibid.
422-434) that does operate on the user's own items — real, and small enough that
the shape of the table still holds. So Lazy's window and Tenon's `Cmd+K` were never two similar
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
videos, and repos: what capture actually meets most of the time. It is reached
through an explicit reader invoked after the user picks an action — never through
the ambient capture seam, which runs on every hotkey press. Reading an
already-visible Tenon URL Preview stays a deferred *second* source for JS-rendered
or signed-in pages.

**Direction check.** Lazy is a read-later/collection product; Tenon is a context +
agent workbench. Deleting the `embedType`/`embedId` schema (`embed-strategy.md`,
option C) is a deliberate step *away* from read-later. Capture here earns its keep
by being findable and agent-readable (D9), not by looking rich.
