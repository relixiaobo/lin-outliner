# Unified Command Surface

## Goal

**One object model and one action registry** behind every surface that acts on
something Tenon can present.

- Every row or chip in the main/parameter result lists is an **object**; every row
  in `Actions ⌘K` is an **action** resolved for the active subject object. Neither
  row type smuggles both into a phrase such as *Go to Today* or *Open Settings*.
- The node context menu becomes a *filtered, anchored action view* for the object
  set carried by that menu opening.
- The command surface becomes the searchable **object** view, and the only one
  summoned by a hotkey in-app and out-of-app alike. Its `Actions ⌘K` panel is
  the searchable view of the registry for the active object.
- The context menu is a **subset**, never a second implementation. **In-app the
  command surface covers all of it.** Out of app it covers everything that does not
  need a fact only the main renderer can attest — one rule, from which the exact
  inventory follows (D1). Stated here rather than promised away.

The user-visible promise: **one identifiable object, then one action with one
meaning.** Ordinary content and destinations read as nouns while actions read as
verbs. A genuinely named tool may use a verb phrase (*Search Files*) yet remain an
object because it has stable identity and its own actions; a fused label alone does
not make *Open Settings* a command object. Multiple entry points are fine; compound
pseudo-command rows and multiple implementations are not.

**Shape (b): two independent complete features**, split at the proof boundary
(see *Shape and build order*). PR 1 makes the context menu a view of the registry
with mechanically proven parity outside an explicit approved-delta list, normalizes
the current action vocabulary, and fixes the `Move to` picker. PR 2 builds the
object-first command surface and the capture loop on that foundation.

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
2. **Objects and actions are the product surface**, so both need one model. A verb
   that exists only in a right-click menu is invisible to the keyboard and to
   search; a destination encoded inside a command label cannot share the actions
   of the same object found by another route.

**What this delivers, stated honestly.** The visible changes are bounded but not
invisible: the launcher replaces the separate palette; `Move to` can no longer hide
a valid ranked destination; action copy reflects the actual object/effect (including
row-policy `remove` and explicit Done targets); free-text creation appears only as a
no-match fallback; and capture reports completion and can hand the page to the
agent. The daily writing loop does not get faster; that belongs to
`performance-optimization.md`. Judge the result against that claim, not a broader
one.

**Where the registry's real value is.** Not merely that future actions get a
keyboard path for free. Because objects have stable refs and `effect` is a
serializable instruction, the registry lives in core, and *composer handoff* is
already one of the effect ops (D9), this is the seam where **an agent capability
becomes a user-callable action** — the same object, the same action family, the
same parameter binding, whether a person picks it or a Skill exposes it. For a
product aimed at directing local agents, that is not debt repayment; it is the
floor the product surface stands on.

The evidence behind both, and the boundary against the product this surface was
modelled on, are in the appendix — they are provenance, not design, and a builder
does not need them to build.

## Non-goals

- **No habit-adaptive default action.** Default activity is a fixed rule.
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
  `reference/browser-extension-integration.md` is a historical filename for a plan whose own
  non-goals exclude extensions.

  **It is a separate API, not the ambient seam.** `captureExternalContext` runs on
  *every* hotkey press (`main.ts:1717-1733`), so nominating `PageContentExtractor`
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
- **No Cartesian `Target × Verb` matrix.** Separating objects from actions does not
  materialize every possible pairing. The registry resolves only actions whose
  predicates accept the selected object and current attested context.
- **No Raycast-style tool/extension command provider in these two PRs.** A genuine
  command can be a first-class object when Tenon has an independently named tool or
  workflow with its own identity and secondary actions. The current launcher has no
  such object: its two `LauncherCommandView` entries are app surfaces written as
  compound phrases. This plan reclassifies those entries; it does not pre-empt the
  future object kind with an empty provider.
- **Other context menus are not migrated here** — the sidebar row menu, Thread
  item menu, inline-file menu, and field-row menu remain separate consumers. The
  object model can represent non-node objects without making every menu part of
  this feature or turning the command surface into a junk drawer.
- **No AI runtime work.** `Send to Agent` reuses the shipped
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
- **`panelRootId` is read by exactly one predicate — whose action is not in the set
  PR 1 migrates.** `idsAllowedForStructuralOutdentBatch` returns
  `row.parentId !== panelRootId`, but **Outdent is not a context-menu entry at
  all**: it and Indent are keyboard-only selection shortcuts (`Shift+Tab` / `Tab`,
  `shortcutRegistry.ts:108-109`). The menu proves it by what it passes — a
  *synthesized* `actionPanelRootId = activeNodeIds[0] ?? node.parentId ?? node.id`
  (`NodeContextMenu.tsx:142`), which is not a pane root and would be wrong if
  anything read it.

  So **PR 1's contract carries no pane root**, and the seed does not try to supply
  one. That is not a convenience: the authoritative value is renderer-owned
  (`WorkspacePanelState.view.rootId`, threaded as `selectionRootId`), the same node
  can appear under different pane roots, and main cannot recover the renderer's
  chosen one from the projection. Inventing a value would be worse than omitting it.

**So the object resolvers, registry and predicates live in `src/core/`.**
Evaluation reads exactly two things — the document, and the main-owned invocation
containing the objects the user can act on:

```ts
interface ActionContext {
  projection: DocumentProjection;   // crosses IPC already
  invocation: ActionInvocation;     // object set + attested contextual facts
}
```

Panel identity lives in attested `view` context keyed to a node object's ref,
because it identifies *which presentation of that node* the user is acting from;
it has no independently selectable row and therefore is not a `SurfaceObject`.
`visualRowId` and `rowExpanded` qualify that same presentation and therefore live in
`view`; `isPinned` qualifies workspace chrome and lives in `workspace`. There is
one object shape across both surfaces, not a node shape plus a separate launcher-only
command shape. A future command object would be one more arm of this same
discriminated model.

**Out-of-app coverage follows one rule, and the inventory is derived from it, not
listed by hand.**

> An action resolves `absent` out of app **iff** its subject object does not exist in
> that opening, or it requires a contextual fact only the main renderer can attest —
> `view` identity/row state or `workspace` state.

Applying it to the current set:

| Absent out of app | Why |
|---|---|
| *Edit filters/sorting/grouping/displayed fields* and *Show/Hide view toolbar* | no attested `view` / visual-row context |
| *Pin* / *Unpin* | read `workspace.isPinned` |

Everything else — including *View as* and *Open in split pane*, which consume
neither attested part — resolves identically in both views. (*Outdent* was listed here in an earlier draft.
It is not in the migrated set at all — see D1 — so it has no row.) **This is not a lesser build**: each entry is
defined relative to a workspace or view that genuinely is not there, which is D7
doing its job. Earlier drafts said "exactly two", which was wrong in both directions;
the rule is the contract and the table is its consequence.

### D1a — One object model, one action model, explicit seam contracts

Two review rounds killed a single `ActionDefinition` written in prose, each time
because one field could not hold the real action set. The later object/action audit
found the inverse failure: destinations and commands had been made action rows even
though D6 said rows were objects. **A type asserted in a document cannot be
falsified, and a noun/verb rule not represented in the type cannot be enforced.**
These contracts land as compiling TypeScript in PR 1 (see *Shape*), populated with
the whole existing set, so the compiler decides whether both claims hold.

```ts
// 0. OBJECT — every object/parameter row, chip and action subject uses this model.
//    System nodes are node objects too; their resolver may ensure the backing node
//    before `open`.
type NodeObjectRef =
  | { by: 'id'; nodeId: NodeId }
  | { by: 'system'; key: 'today' | 'library' | 'schema' | 'savedSearches' | 'trash' };

interface NodeObject {
  kind: 'node';
  objectRef: ObjectRef;
  row: NodeObjectRef;              // structural occurrence: duplicate/move/remove
  content: NodeObjectRef;          // semantic target: done/tag/description/copy/agent
  canonicalSurface: NodeObjectRef; // activation target: open/split/pin
}

type SurfaceObject =
  | NodeObject
  | { kind: 'nodeSelection'; objectRef: ObjectRef; nodes: readonly NodeObject[] }
  | { kind: 'externalPage';  objectRef: ObjectRef; contextId: ExternalContextId }
  | { kind: 'draft';         objectRef: ObjectRef; purpose: 'node' | 'tag'; text: string }
  | { kind: 'appSurface';    objectRef: ObjectRef; surface: 'mainWindow' | 'settings' };

// There is deliberately no `command` arm in this release. `Open main window` and
// `Open Settings` are app-surface objects plus `open`; a future independently
// named tool/workflow may add a genuine command-object provider when one ships.

type PresentedName =
  | { source: 'literal'; value: string }             // node/draft/page content
  | { source: 'localized'; values: LocalizedNames }; // system/app/selection labels

interface ObjectPresentation {
  objectRef: ObjectRef;
  kind: SurfaceObject['kind'];
  name: PresentedName;
  subtitle?: PresentedName;
  iconId: IconId;
  typeLabel: LocalizedNames;
}

type ActionSurface = 'contextMenu' | 'actionPanel'; // never `mainList`

// 1. INVOCATION — the object membership available in one opening. Main-owned;
//    crosses the seam as an opaque id. Fixed subject objects survive query changes;
//    the one subject-result generation is replaced atomically on every accepted
//    main-list query. Argument objects have a separate, slot-scoped capability domain.
type ObjectResultGeneration = {
  generation: number; // main-owned monotonic counter; request ids are not trusted
  requestId: RequestId;
} & (
  | { state: 'pending'; objects: readonly [] }
  | { state: 'ready'; objects: readonly SurfaceObject[] }
);
type ObjectParameterId = {
  [K in ActionId]:
    K extends 'move' ? 'destination'
      : K extends 'addTag' ? 'tag'
        : K extends 'capture' ? 'destination' | 'tag'
          : K extends 'create' ? 'destination'
            : never;
};
type ArgumentSlot = {
  [K in ActionId]: {
    actionId: K;
    subjectRef: ObjectRef;
    parameterId: ObjectParameterId[K];
  }
}[ActionId];
type ArgumentObjectGeneration = {
  slot: ArgumentSlot;
  generation: number; // from the same main-owned monotonic counter
} & (
  | { source: { kind: 'resolver' }; state: 'ready'; objects: readonly SurfaceObject[] }
  | { source: { kind: 'query'; requestId: RequestId };
      state: 'pending'; objects: readonly [] }
  | { source: { kind: 'query'; requestId: RequestId };
      state: 'ready'; objects: readonly SurfaceObject[] }
);
interface ActionInvocation {
  fixedObjects: readonly SurfaceObject[]; // menu anchors + resolved ambient chip
  resultGeneration?: ObjectResultGeneration; // node/system/app/draft results
  argumentGenerations: readonly ArgumentObjectGeneration[];
  draftText: string; // sanitized input payload; never an implicit subject choice
  // ATTESTED by the main renderer only (sender-checked; see D1b). Never suppliable
  // by the launcher. Facts are tied to the object they qualify, never treated as
  // standalone rows.
  view?: readonly {
    objectRef: ObjectRef; panelId: string; visualRowId: NodeId; rowExpanded: boolean;
  }[];
  workspace?: readonly { objectRef: ObjectRef; isPinned: boolean }[];
}

type AmbientSlot = {
  requestId: AmbientRequestId;
  revision: number;
} & (
  | { state: 'pending' | 'none' }
  | { state: 'resolved'; objectRef: ObjectRef }
);

// 2. EVALUATION — three raw states, never a bare list. `absent` has no subject and
//    therefore never produces an ActionPresentation.
type ActionEvaluation =
  | { status: 'applicable' }
  | { status: 'rejected'; reason: ActionRejection }
  | { status: 'absent' }; // no subject object at all -> hidden
type PresentableEvaluation = Exclude<ActionEvaluation, { status: 'absent' }>;

// Arguments already known for a parameterized variant. This is an explicit map per
// action family, not generic Partial<ActionArguments[K]>; the registry descriptor
// decides which one missing field the ParameterSpec is allowed to fill. Every
// object-valued spec declares its ObjectParameterId and exact ActionArguments path;
// the presentation builder, request codec and admission check read that same entry.
type ActionArgumentBinding<K extends ActionId> =
  | { state: 'ready'; arguments: ActionArguments[K] }
  | { state: 'needsParameter'; seed: ActionArgumentSeed[K]; parameter: ParameterSpec<K> };

// 3. PRESENTATION — object rows and resolved action variants stay separate. A
//    family can yield several direct variants (setDone true/false, copy text/id)
//    without inventing unrelated action ids or compound command rows. Mapped union
//    keeps each family correlated with its own binding and parameter spec.
type ActionPresentationFor<
  K extends ActionId,
  B extends ActionArgumentBinding<K> = ActionArgumentBinding<K>,
> = {
  actionId: K;
  subjectRef: ObjectRef;
  names: LocalizedNames;
  aliases: readonly string[]; // locale-independent search terms; never action ids
  iconId: IconId;
  surfaces: readonly ActionSurface[];
  evaluation: PresentableEvaluation;
  binding: B;
  confirm?: ConfirmationSpec;
};
type ActionPresentation = {
  [K in ActionId]: ActionPresentationFor<K>
}[ActionId];
type ReadyActionPresentation = {
  [K in ActionId]: ActionPresentationFor<K, {
    state: 'ready'; arguments: ActionArguments[K];
  }>
}[ActionId];
interface SurfaceItemPresentation {
  object: ObjectPresentation;
  primaryAction?: ActionPresentation; // selections may have no safe blind-Enter action
  actions: readonly ActionPresentation[];
}

// 4. REQUEST — the only EXECUTION request a renderer may send. Object queries and
//    lifecycle events have their own bounded contracts below. No command, no effect,
//    draft text, or self-asserted confirmation enters through this request.
type ActionRequest = {
  [K in ActionId]: {
    actionId: K;
    invocationRef: InvocationRef;
    subjectRef: ObjectRef;
    arguments: ActionArguments[K];
    challenge?: ChallengeToken; // minted by main; single-use; see D1b
  }
}[ActionId];

// 4b. INVOCATION RECORD — main-owned. The ref is an opaque handle to this.
interface InvocationRecord {
  invocation: ActionInvocation;
  origin: 'main' | 'mainRenderer';  // main-origin records are first-class, not a fiction
  // Present IFF the invocation carries `view` or workspace facts. Those are the
  // only parts a renderer can attest; node/page/system/app-surface objects main
  // resolves or constructs itself.
  attestation?: { webContentsId: number; renderGeneration: number };
  consumableBy: RendererId;
  openSeq: number | null;           // null when not bound to a launcher opening
  // Launcher-only slot. The invocation exists before ambient capture resolves.
  ambient?: AmbientSlot;
  phase: InvocationPhase;           // atomic; see D1b
  expiresAt: number;
}
type InvocationPhase = 'live' | 'confirming' | 'executing' | 'spent';

// 4bis. CREATION — the ref every request needs has to come from somewhere, and a
//    renderer must not be able to author the parts main is supposed to attest.
type InvocationSeed =
  // main-renderer only; SENDER-CHECKED. Carries renderer-owned FACTS, never a
  // finished ActionInvocation: main validates ids, constructs node / selection
  // objects, derives row/content/canonical-surface facets plus selection roots,
  // and mints refs, origin, attestation, lifetime and consumer.
  | { from: 'mainRenderer'; anchorNodeId: NodeId; visualRowId: NodeId;
      selectedIds: readonly NodeId[]; panelId: string;
      isPinned: boolean; rowExpanded: boolean }
  // NOTE: no pane root. See D1 — the only predicate that reads one belongs to an
  // action that is NOT in the menu PR 1 migrates.
  // Main-origin objects are built INSIDE main and never arrive as authored object
  // records over IPC: captured page, node-search result, system node, app surface,
  // and a sanitized bounded draft derived from the launcher's current input.
  ;
interface InvocationOpened {
  invocationRef: InvocationRef;
  openSeq: number | null;
  ambient?: { state: 'pending' | 'resolved' | 'none'; revision: number };
  fixedItems: readonly SurfaceItemPresentation[];  // chips / anchored objects
  resultItems: readonly SurfaceItemPresentation[]; // current ready generation
  menuActions: readonly ActionPresentation[];
}

// 4c. OBJECT QUERY — the only way a launcher search generation enters the
// invocation. Main first installs an empty `pending` generation (invalidating every
// prior result ref), then installs fresh objects only if this request is still current.
interface ObjectQueryRequest {
  invocationRef: InvocationRef;
  openSeq: number;
  requestId: RequestId;
  query: string;
}
type ObjectQueryResult =
  | { status: 'ready'; invocationRef: InvocationRef; openSeq: number;
      requestId: RequestId; generation: number;
      resultItems: readonly SurfaceItemPresentation[] }
  | { status: 'superseded'; invocationRef: InvocationRef; openSeq: number;
      requestId: RequestId; generation: number };

// 4d. PARAMETER QUERY — argument rows use the same SurfaceObject shape but a
// capability generation scoped to one exact action + subject + parameter slot.
interface ParameterObjectQueryRequest {
  invocationRef: InvocationRef;
  openSeq: number | null;
  slot: ArgumentSlot;
  requestId: RequestId;
  query: string;
}
type ParameterObjectQueryResult =
  | { status: 'ready'; invocationRef: InvocationRef; slot: ArgumentSlot;
      requestId: RequestId; generation: number;
      items: readonly ObjectPresentation[] }
  | { status: 'superseded'; invocationRef: InvocationRef; slot: ArgumentSlot;
      requestId: RequestId; generation: number };

// 4e. AMBIENT CONTEXT — main owns this transition. External capture resolves in
// main; an in-app seed first passes its sender/ID checks. Neither renderer may post
// a finished object. Main pushes only the authoritative replacement presentation.
interface InAppAmbientSeedResponse {
  invocationRef: InvocationRef;
  openSeq: number;
  requestId: AmbientRequestId;
  seed: InvocationSeed; // sender-checked main renderer only
}
type AmbientContextResolution =
  | { kind: 'externalPage'; contextId: ExternalContextId }
  | { kind: 'inApp'; seed: InvocationSeed }
  | { kind: 'none' };
interface AmbientContextResolved {
  invocationRef: InvocationRef;
  openSeq: number;
  requestId: AmbientRequestId;
  resolution: AmbientContextResolution;
}
type AmbientContextChanged =
  | { status: 'updated'; invocationRef: InvocationRef; openSeq: number;
      revision: number; ambientState: 'resolved' | 'none';
      fixedItems: readonly SurfaceItemPresentation[] }
  | { status: 'superseded'; invocationRef: InvocationRef; openSeq: number;
      requestId: AmbientRequestId };

// 4f. LIFECYCLE EVENT — the other inbound message. Like ActionRequest it can only
//     NAME a transition; main decides whether it is legal in the current phase.
type InvocationEvent =
  | { kind: 'confirmationCancelled'; invocationRef: InvocationRef; challenge: ChallengeToken }
  | { kind: 'objectRemoved'; invocationRef: InvocationRef; objectRef: ObjectRef }
  | { kind: 'selectionMemberRemoved'; invocationRef: InvocationRef;
      selectionRef: ObjectRef; memberRef: ObjectRef }
  | { kind: 'abandoned'; invocationRef: InvocationRef };   // menu/panel closed
type InvocationEventResult =
  | { status: 'updated'; opening: InvocationOpened }
  | { status: 'spent' };

// 5. EFFECT — produced by main, never accepted from a renderer. An ORDERED PLAN,
//    because real actions cross executors: `editViewSection('filter')` runs
//    setViewToolbarVisible and only THEN reveals the filter editor.
interface ActionEffectPlan {
  steps: readonly EffectStep[];       // in order; a failed step stops the plan
  completion: 'restoreInvoker' | 'stayAtDestination';   // D9 focus policy, per action
}

// ONE value-level descriptor. Types are derived from it, and the codec and the
// executor read the same object — an `interface` could do neither, because
// TypeScript erases it.
export const ACTION_BINDINGS = {
  // PRODUCERS: which commands yield a bindable value, and WHERE it lives in the
  // real `CommandResult`. Commands return `focus?: FocusHint` (`core/types.ts:658-661`)
  // — there is no `result.focusNodeId` anywhere, so the extraction path is stated
  // rather than assumed. `create_tag` and `create_capture` both return `focus(id)`,
  // and `documentService` forwards `result.focus`.
  produces: {
    ensure_date_node: { focusNodeId: ['focus', 'nodeId'] },
    create_tag:       { focusNodeId: ['focus', 'nodeId'] },
    create_capture:   { focusNodeId: ['focus', 'nodeId'] },
  },
  // CONSUMERS: exact arg paths that may hold a step reference. Paths, rather than
  // top-level field names, express the real `create_capture.input.destinationParentId`
  // shape. They remain explicit because `NodeId` IS `string` (`core/types.ts:31`).
  consumes: {
    create_capture:  [['input', 'destinationParentId']],
    apply_tag:       [['nodeId'], ['tagId']],
    batch_apply_tag: [['tagId']],
    // …one line per consumer; everything unlisted stays literal.
  },
} as const;

type BindableCommand = keyof typeof ACTION_BINDINGS.produces;
type Bound<T> = T | { fromStep: StepRef; field: 'focusNodeId' };
type BindAtPath<T, P extends readonly PropertyKey[]> =
  P extends readonly [infer Head, ...infer Tail extends readonly PropertyKey[]]
    ? Head extends keyof T
      ? { [K in keyof T]: K extends Head
          ? Tail extends readonly [] ? Bound<T[K]> : BindAtPath<T[K], Tail>
          : T[K] }
      : never
    : T;
type BindAtPaths<
  T,
  Paths extends readonly (readonly PropertyKey[])[],
> = Paths extends readonly [
  infer Head extends readonly PropertyKey[],
  ...infer Tail extends readonly (readonly PropertyKey[])[],
]
  ? BindAtPaths<BindAtPath<T, Head>, Tail>
  : T;
type ConsumerPaths<K extends CommandName> =
  K extends keyof typeof ACTION_BINDINGS.consumes
    ? typeof ACTION_BINDINGS.consumes[K] : readonly [];
type BoundCommandArgs<K extends CommandName> = BindAtPaths<
  CommandArgs[K], ConsumerPaths<K>
>; // only descriptor leaves become `Bound<T>`

// Mapped union: args are correlated WITH the command name, and `bindAs` exists only
// where a result exists to bind.
type CommandStep = {
  [K in CommandName]: {
    on: 'main'; kind: 'command'; command: K; args: BoundCommandArgs<K>;
  } & (K extends BindableCommand ? { bindAs?: StepRef } : { bindAs?: never })
}[CommandName];

type EffectStep =
  | CommandStep
  // `Bound<NodeId>` wherever a consumer legitimately reads a previous step's result.
  | { on: 'mainRenderer'; kind: 'navigate'; nodeId: Bound<NodeId>; inPlace: boolean }
  | { on: 'mainRenderer'; kind: 'reveal'; surface: RevealTarget }
  | { on: 'mainRenderer'; kind: 'workspace'; op: 'pin' | 'unpin' | 'openSplitPane'; nodeId: Bound<NodeId> }
  // BrowserWindow lifecycle belongs to the native host and still works when the
  // main renderer does not exist. `open(appSurface)` resolves to this step.
  | { on: 'main'; kind: 'activateAppSurface'; surface: 'mainWindow' | 'settings' }
  | { on: 'main';     kind: 'clipboard'; text: string }   // main resolves + writes it
  | { on: 'mainRenderer'; kind: 'composerHandoff'; object: ComposerObject; draftText: string };

// 5b. REQUEST RESULT — what an ActionRequest returns. The first Flow-A leg is a
//    response, not a side effect, so it needs a branch that can carry the token.
type ActionRequestResult =
  | { status: 'confirmationRequired'; challenge: ChallengeToken; confirm: ConfirmationSpec;
      presentation: ReadyActionPresentation } // authoritative copy + subject + args for the dialog
  | { status: 'reEvaluated'; presentation: ActionPresentation } // current subject, changed args/state
  | { status: 'stale'; reason:
      | 'invocation' | 'subject' | 'subjectGeneration'
      | 'argument' | 'argumentGeneration' }
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

**Invocation membership is current state, not an opening-time snapshot.** An
action subject is admissible only when its ref is in `fixedObjects` or in the one
`ready` result generation named by the record. On every `ObjectQueryRequest`, main
validates `(invocationRef, openSeq, consumer)`, sanitizes and bounds the text, and
atomically replaces the previous generation with an empty `pending` generation
*before* retrieval begins. That first transition invalidates every old node-result
and draft ref; if a `confirming` challenge named one of them, the same transaction
revokes it and returns the record to `live`. Main increments a private generation
counter on that transition;
retrieval may install fresh refs only when the captured generation is still current
and the phase still admits queries,
so a compromised caller cannot revive work by reusing a `requestId`. Otherwise it
returns `superseded`. The renderer independently
drops any response that does not match its latest `(openSeq, requestId)`, so neither
IPC arrival order nor an old draft replay can resurrect a stale subject.
Refs are generation-scoped: the same backing node found twice receives a new
`ObjectRef`, while its `NodeObjectRef` continues to identify the same document node.
Deleting a result subject also deletes every argument slot keyed to that ref. The
initial `InvocationOpened` synchronously installs a main-minted ready empty-query
generation, which is why its Today/system/app rows are already legal subjects before
the first keystroke. Queries and membership edits are admitted only in `live` /
`confirming`; `executing` has already frozen the plan, and `spent` is terminal.

**Argument objects use the same object model and a different membership domain.**
An object-valued argument is admissible only when its ref belongs to a `ready`
`ArgumentObjectGeneration` whose `slot` exactly matches the request's
`(actionId, subjectRef, parameterId)`. Main materializes the backing node/tag/draft
from that record; a renderer never substitutes a `NodeId`, text, or a ref from the
main subject list. This is why the same Today `NodeObjectRef` may have one main-list
subject ref and another capture-destination argument ref: the noun is the same, but
the two refs grant different uses and lifetimes.

Resolver-installed arguments and queried candidates share that store. When
`capture(page)` or `create(draft)` is presented, main installs Today in the exact
`destination` slot with `source.kind = 'resolver'`; that generation survives
main-list queries as long as its subject remains current. Re-evaluation reuses that
generation when the slot and backing object are unchanged; it does not mint a new ref
merely because an execution request arrived. A parameter query first
installs an empty `pending` generation for only its named slot, then installs fresh
objects if its private generation is still current. It invalidates the previous
candidate refs for that slot, never another action's candidates and never the main
result generation. Removing/replacing a subject, re-evaluating away its action,
spending the invocation, or replacing the same argument generation invalidates its
refs and revokes any challenge that names them. Stale candidates and refs replayed
across action, subject, or parameter slots return `stale`; they are never accepted by
backing identity alone.

`draftText` is updated in that same main-owned transition, but it is **payload, not
selection**. The same characters drive object retrieval and may later become a page
note or composer question; they never make a result the active subject by
themselves. `ActionRequest` therefore carries neither note nor question text: main
reads the latest bounded `draftText` from the admitted invocation when resolving
`capture` or `sendToAgent`. The launcher's 120 ms debounce delays **retrieval**, not
this admission: every input event sends its query immediately, and the main handler
updates `draftText` plus the empty `pending` generation before its first await, then
resets the retrieval timer. IPC order from the same sender therefore makes
type-then-immediate-Enter observe the latest text even though results have not
resolved yet.

**The launcher invocation opens before ambient context resolves.** Main creates the
record synchronously for the new `openSeq`, installs the ready empty-query result
generation, marks its one ambient slot `pending`, and shows/focuses the panel. The
existing external capture or the sender-checked in-app seed may arrive later. Only
the main renderer may answer the corresponding main-issued request with
`InAppAmbientSeedResponse`; main validates that sender and the opaque tuple before
using its raw facts. Only main calls `AmbientContextResolved`; it validates
`(invocationRef, openSeq, AmbientRequestId, phase)`, then atomically installs or
replaces the fixed page/node/selection object (or records `none`) and pushes
`AmbientContextChanged`. That transition preserves `draftText`, the current main
result generation, and unrelated argument generations. Replacing an old ambient
subject invalidates that ref and its argument slots; if a confirmation named it, the
challenge is revoked and the phase returns to `live`.

Ambient resolution is serialized with object queries but updates disjoint fields, so
typing while capture is slow loses neither the text nor the ready result that later
arrives. A resolution for an old opening/request, or one arriving after `executing`,
is `superseded` without changing membership. The launcher cannot call this
transition, and a main-renderer seed is converted into an object only after sender,
render-generation, and node/selection validation. Activity after the authoritative
push is the deterministic renderer rule in D4; membership does not itself invent a
selection. Every install, replacement, `none` result or ambient-chip removal
increments `ambient.revision`; the renderer applies only a matching `openSeq` with a
strictly newer revision, so a delayed push cannot resurrect a replaced or removed
chip.

**Removing a chip changes membership through main.** `objectRemoved` deletes one
fixed object; `selectionMemberRemoved` validates the member and atomically replaces
the aggregate selection with a freshly referenced aggregate (or a single node / no
chip when the remaining cardinality requires it). Main re-derives the replacement's
node facets and rekeys only still-current attested facts; the event cannot supply
either. Removed and replaced refs stop
being admissible immediately while the opening itself remains live; the returned
`InvocationOpened` is the authoritative replacement presentation. Removing the
ambient object also advances its revision and leaves the slot at `none`, preventing
an older context push from reattaching it. `abandoned` is
reserved for closing the menu or panel; it no longer conflates "remove this object"
with "discard this invocation".

**The three node facets preserve one object, not three rows.** For an ordinary node
they are identical. For a reference occurrence, `row` is the reference while
`content` and `canonicalSurface` resolve to its target. For a field row, `row` and
`content` are the entry while `canonicalSurface` is the field definition used by
the shipped drill-down/pin path. Main derives all three from the anchored row and
projection; a renderer never supplies the resolved ids. This is required for D2
parity: structural actions keep acting on the occurrence, content actions keep
acting on the target, and `open` / `openInSplitPane` / `setPinned` keep using the
current `openId` semantics without creating compound objects or action ids.

**The canonical catalog is action families, not menu labels.** A resolved
presentation binds a subject object and, where needed, typed arguments. Several
presentations may therefore share one `actionId` without sharing an effect by
accident:

| Action family | Subject object | Typed arguments / resolved presentations |
|---|---|---|
| `open` | node canonical surface or app surface | one meaning: activate in the object's canonical surface; `go` / `navigate` are search aliases, never action ids |
| `openInSplitPane` | node canonical surface | none; separate because it changes the destination container |
| `setPinned` | node canonical surface + attested workspace facts | `pinned: true | false` -> *Pin* / *Unpin* |
| `sendToAgent` | node content or external page | stages that object plus the existing draft text; never named after the composer implementation |
| `duplicate` | node row or selection rows | none |
| `move` | node row or selection rows | relative `up` / `down`, or destination node object |
| `setDone` | node content or selection contents | `done: true | false` -> *Mark done* / *Mark not done* |
| `addTag` | node content or selection contents | existing tag object or a tag draft resolved as create-then-apply |
| `setViewMode` | node content | `outline | table`; available out of app because it needs no renderer fact |
| `setViewToolbarVisible` | node content + attested view/row facts | `visible: true | false` -> *Show* / *Hide view toolbar* |
| `editViewSection` | node content + attested view context | `filter | sort | group | display` -> *Edit filters/sorting/grouping/displayed fields* |
| `editDescription` | node content | none; an empty description is still edited, not a second `addDescription` action |
| `copy` | node content | `text | nodeId` |
| `remove` | node row or selection rows | no renderer-chosen mode; row policy resolves *Move to Trash*, *Remove field value(s)* or mixed *Remove selected items* |
| `restore` | trashed node row | none |
| `deleteForever` | trashed node row or selection rows | none; native confirmation in PR 2 |
| `emptyTrash` | the Trash system-node object | none; native confirmation in PR 2 |
| `capture` | external page | Today node object is a bound destination; optional tag object |
| `create` | node-purpose draft | Today node object is a bound destination; creates a plain node with no capture provenance |

The family/argument boundary follows one rule: **the same user intent with a
different target state, direction, representation, selected parameter or
row-policy consequence stays one family; a different interaction surface,
provenance model, irreversible boundary or confirmation contract is a different
action.** Internal core commands do not define this product taxonomy.

**The full-catalog audit leaves 19 families.** `go` / `navigate` collapse into
`open`; pinning, completion and toolbar visibility become explicit setters; view
sections, copy representations and move directions become typed arguments; *Add
description* collapses into `editDescription`; and the misleading `moveToTrash`
becomes `remove`. Three superficially similar cases remain separate for product
reasons: `openInSplitPane` creates a second container instead of activating the
object's canonical one; `sendToAgent` hands the object to another interaction
surface; and `restore`, `deleteForever` and `emptyTrash` have distinct availability,
reversibility and confirmation contracts. There is no `run` family yet because the
current release has no genuine command object to run.

**`remove` names the intent; row policy chooses the effect.** The shipped delete
path already partitions selected rows through `SelectableRow.actionPolicy.delete`:
ordinary rows run `batch_trash_nodes`, while field-value rows run
`remove_field_value` so option-pool cleanup still happens. Calling that family
`moveToTrash` would make the action id false for part of its accepted subject set.
It is not `move(destination: Trash)`: field values never enter Trash, and the user
is invoking a fixed row-policy operation rather than choosing a destination. The
resolved presentations are therefore:

| Resolved row-policy set | Action name | Effect plan |
|---|---|---|
| ordinary row(s) only | *Move to Trash* | one `batch_trash_nodes` step |
| field-value row(s) only | *Remove field value* / *Remove field values* | ordered `remove_field_value` steps |
| both kinds | *Remove selected items* | the shipped order: batch trash first, then field-value removals |

The policy is re-derived from the row facets during evaluation and execution; it
is not an argument a renderer may assert. Disabled rows are excluded exactly as
today. All three presentations retain one user intent -- remove these structural
occurrences according to their row semantics -- and remain undoable. `restore` is
still separate because it accepts only rows already in Trash and reverses that
container transition; permanent deletion keeps its own confirmation boundary.

`sendToAgent` deliberately does **not** accept a node selection in this release.
The shipped context-menu action sends the anchored content node even when several
rows are selected; its node-subject presentation preserves that behavior. Making
an aggregate selection stage several node references would be a new handoff flow
with its own visible/removable staging rules, not a type-level generalization to
smuggle into this migration.

There is deliberately **no generic toggle action**. The presentation records the
desired end state and main re-evaluates that exact state at execution time. For a
homogeneous node or selection, only the state-changing variant is presented. For a
mixed node selection, `setDone(true)` and `setDone(false)` are both available; each
changes only nodes not already in the requested state. The shipped
`batch_toggle_done` currently flips every node independently
(`core.ts:1764-1771`), so *Toggle done* can turn one mixed selection into a
different mixed selection. Replacing it is an approved behavior correction, not
part of the parity claim.

Why each exists, in the order the reviews forced them:

**Invocation contains an object set plus contextual facts, not one union arm,
because one opening is composite.** A single right-click carries the anchored node
*and* the live multi-selection *and* view/toolbar state *and* pin state simultaneously
(`NodeContextMenu.tsx:63-81`), and derives batch subjects from the anchor and the
selection **together** (`:135-203`). D2 then renders node, selection and view
actions from that one opening. A union admits exactly one of those, so a literal
implementation would have to drop actions, smuggle the rest in after admission, or
invent an undocumented multi-ref merge. The invocation carries them all; each
action reads the subject object and contextual facts it needs and ignores the rest.

**Who supplies what, and where each fact stops being available.** Main derives
everything document-shaped from the projection (`targetId` resolution, descendant
and Trash exclusion, `mutable`, row policy). The `view` and `workspace` parts are
different in kind, and the previous revision got them wrong by treating
"renderer-owned" as one category:

**Dependencies are declared per action, not per category.** Each entry names the
context fields it needs; the envelope is not an all-or-nothing gate. Bundling them
was an unnecessary parity loss:

- **Pin / Unpin need `isPinned`**, which lives in the *main renderer's* React state
  and localStorage (`useWorkspacePinnedNodes.ts`). The launcher is a **different
  renderer** with no access to it, so those two resolve **`absent` out of app** —
  the same shape as *Outdent* without a view: the action is defined relative to a
  workspace that is not there.
- **Open in split pane needs nothing from `workspace`.** It carries a node id and
  routes to `mainRenderer` like any other step, so it **stays available out of
  app**. An earlier draft gated it on the whole bundle and lost parity for no
  reason.

**The toolbar setter is the one place a renderer fact must reach a command, and it
gets a named exception rather than a bent rule.** The menu computes
`viewToolbarVisibleInRow = view.toolbarVisible && props.viewToolbarVisibleInRow`
and the resolved presentation binds **its desired opposite state** into the command
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

**One opening produces one `InvocationRef`, one fixed subject set, at most one current
subject-result generation, independently keyed argument generations and one ordered
action list**, so a menu never assembles itself from several invocation refs and a
command row never authors an object/action pair locally.

**Evaluation has three states because the two projections treat non-applicability
differently.** D2 must preserve the menu's existing disabled rows; D7's searchable
action panel shows a rejected action *with its reason* and hides an action that has
no subject object. One empty array cannot express all three, and carries no reason
either way.

**Object presentation and action presentation are separate from definitions**
because the same object renders as a row or chip, the same action family yields
bound variants, and icon ids resolve per view (below).

**Surface exposure is registry metadata, not a view-owned allow-list.** The
context-menu projection reads `surfaces.includes('contextMenu')`; the action panel
reads `surfaces.includes('actionPanel')`. `mainList` is not a valid action surface,
which makes the object/action split structural. A later panel-only action such as
Indent/Outdent must add that exposure deliberately without changing the menu set.

**Request is the admission contract** — see D1b. It is deliberately the smallest
thing that can name an action **for one subject object with typed arguments**.

**Effect is an ordered plan, discriminated and outbound-only.** The 19 action
families show `mutate | navigate | handoff` under-counts badly: `setPinned` writes
renderer workspace chrome (localStorage, not document state), `openInSplitPane`
creates a panel, `copy` writes the clipboard, and `editDescription` /
`editViewSection` reveal UI. Only about half are core commands, and each carries
its own payload — `op + ...` is not an executable contract.

**And some actions are not single-executor at all.** `editViewSection` runs
`setViewToolbarVisible` through the core command path and only **after it succeeds**
expands the visual row and reveals the requested section
(`NodeContextMenu.tsx:273-277`); *Show view toolbar* has the same command-then-reveal
shape (`:407-420`). A single effect would have to drop one half or let the action
escape back into an ad-hoc renderer callback — which would defeat both the registry
and the differential proof. Hence `steps`: **renderer steps are emitted only after
the preceding main step succeeds**, a failed step stops the plan, and D2's
equivalence proof compares **step order and failure behaviour**, not just the final
command.

**Ordering alone is still not enough — five more things the array had to carry:**

- **Result binding.** *Add tag → Create* runs `create_tag`, reads the returned
  `focus.nodeId`, and only then builds `apply_tag` / `batch_apply_tag`
  (`NodeContextMenu.tsx:260-269`). Steps therefore name their result (`bindAs`) and
  later steps reference it (`{ fromStep, field }`) — a constrained reference, not a
  general expression language. Tagged capture uses the same mechanism twice:
  `ensure_date_node` supplies `create_capture.input.destinationParentId`, and
  `create_capture` supplies the new `apply_tag.nodeId`; a tag draft additionally
  supplies `apply_tag.tagId` through `create_tag`.

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
- **A native-host target.** `open(appSurface)` is neither document navigation nor a
  renderer reveal. It calls `createWindow` + `focusMainWindow` or
  `openSettingsWindow` in main, including when the main window is closed. The typed
  `activateAppSurface` step carries that operation; it cannot fall through to an
  ad-hoc callback or pretend a renderer exists. Its main-host acknowledgement waits
  until the existing window is focused or a newly created window reaches its normal
  ready/show path, so `stayAtDestination` cannot dismiss the panel before there is a
  destination.
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
including `navigate.nodeId`, without which `open` on the Today object is
inexpressible, since it must run `ensure_date_node` and navigate to the id that
command returns through `focus` (`core.ts:2774-2776`, `CommandPalette.tsx:83-86`).
A missing or invalid binding at use is an executor failure
(`{ kind: 'bindingUnresolved' }`), not undefined behaviour.

**Which *paths* accept a reference is an explicit allow-list, not a structural
rule**, because `NodeId` is literally `string` (`core/types.ts:31`). "Replace every
`NodeId` with `Bound<NodeId>`" would also open `create_tag.name`, while a top-level
field list cannot reach the real nested
`create_capture.input.destinationParentId`. A property-name heuristic would be a
guess wearing a type — wrong the first time two ids play different roles. The
descriptor therefore names exact path tuples; `BindAtPaths` and the runtime codec
both derive from those tuples.

**It is a `const` value, not an `interface`, and that is load-bearing.** TypeScript
erases interfaces, so a codec or executor cannot read one; a second value-level copy
would recreate exactly the drift this is supposed to prevent. `ACTION_BINDINGS` is
the single object: the types derive from `typeof` it, and the runtime reads the same
thing.

**The producer path is stated, not assumed.** Commands do not return a
`focusNodeId`. They return `CommandResult` with `focus?: FocusHint`
(`core/types.ts:658-661`); `create_tag` yields `focus(id)` (`core.ts:1918-1924`),
`create_capture` yields the new capture through `focus(id)`
(`core.ts:1106-1131`), and `documentService` forwards `result.focus`. An executor
that stored either result and looked for `result.focusNodeId` would hit
`bindingUnresolved` on `open(Today)`, *Add tag → Create* and tagged capture; a
hand-written `focus.nodeId` special case would be an undocumented second schema.
The descriptor therefore names the extraction path `['focus', 'nodeId']`, and the
executor follows it for all three producers.

That is also what makes the negative fixture mean something: the counterexamples
are **`create_tag.name`** and **`create_capture.input.title`**. The former has the
same underlying type as `apply_tag.tagId`; the latter is a sibling of the permitted
nested destination. Both must fail while `apply_tag.tagId`, `apply_tag.nodeId` and
`create_capture.input.destinationParentId` compile. A fixture using an unrelated
numeric field would have proved nothing.

PR 1 therefore carries a **compile-time negative fixture** — wrong args for a
command, `bindAs` on a non-bindable step, a step ref in a path that does not accept
one, each expected to fail type-checking — alongside a runtime
`ensure_date_node → navigate(bound focus node)` test. PR 2 adds the complete
`ensure_date_node → create_capture(bound destination, bind capture) →
apply_tag(bound capture, literal or bound tag)` runtime plan and both app-surface
host operations. Without those the phrase "the compiler decides" is decoration.

**Typed arguments and parameter objects are what make the catalog coherent.**
Desired states, directions and representations are bound arguments; *Move to*
needs a destination node object, *Add tag* a tag node or tag draft, *View as* a
mode, and capture binds the Today node object plus an optional tag. None becomes a
new compound action id.

**Both need a query transport, not just a spec.** A static `ParameterSpec` cannot
express query-dependent behaviour, and the launcher has no projection to compute it
locally: `interactions/tagSelector.ts` needs a full `DocumentIndex`, the live query
and the already-applied tag ids, and it owns empty-query ordering, exclusion, the
hex penalty and the **dynamic tag-draft object**. Shipping every tag inside a presentation
would be unbounded and stale within a keystroke.

So the pure tag policy moves to core beside the retrieval kernel, and main exposes
the `ParameterObjectQueryRequest` / `ParameterObjectQueryResult` contract above.
The request names the authoritative invocation and the exact
`actionId + subjectRef + parameterId` slot; main first proves that the current
presentation owns that slot, then installs the candidate objects in its
`ArgumentObjectGeneration`. A request cannot create a slot merely by naming one.

It has the same async mechanics as D5 — a private generation, request identity,
out-of-order responses dropped, cancellation on close — plus a parity test against
the existing selector so the policy is provably unchanged. It does **not** share the
main-list result generation: changing a note query cannot invalidate the Today
destination for a fixed page, while changing an `addTag.tag` query invalidates only
the prior tag candidates for that same action and subject. A candidate remains an
**argument object**, not a new action subject: selecting it binds its `objectRef`
into the parent request's typed arguments while preserving the original subject and
`actionId`. Main accepts that ref only from the matching ready slot. A tag draft is
therefore a noun row whose selection lets `addTag` resolve create-then-apply; it does
not gain a speculative top-level `createTag` action or a *Create tag X* command row.
Without this transport `Add tag` would also be absent out of app, which the inventory
in D1 does not claim.

### D1b — Admission: a renderer may name an action, never author one

The previous revision said the panel "returns the chosen effect" and main performs
it. Taken literally that makes the locked-down launcher renderer a **generic
mutation client**: submit `{ kind: 'command', … }` with fabricated subjects and the
document changes. That is an A2/A3/A4 violation and it was the sharpest finding
across both reviews.

**The preload and IPC boundary must make that statement true.** The shipped
launcher uses the shared preload, which exposes the full `window.lin.invoke`; the
generic `lin:invoke` document-command branch has no launcher sender gate. A
compromised launcher could therefore call `get_projection` and `delete_node`
directly, bypassing every invocation check below. PR 2 closes both layers before it
adds the action consumer:

1. `src/preload/launcher.ts` becomes a separate Electron-Vite preload entry and
   exposes only the typed `window.lin.launcher` API. The launcher window loads that
   bundle; navigating or reloading its renderer can never acquire the full app
   bridge. The main, Settings and provider-config renderers keep the existing app
   preload, so their `api/client` path does not regress.
2. Main registers capabilities against the actual `webContents` at window creation
   and checks them at every inbound seam. The launcher receives only launcher/query/
   action-request capabilities; `lin:invoke` rejects it **before dispatch**, and
   every `launcher:*` handler rejects a non-launcher sender. Destroying a
   `webContents` removes its capability record. The minimal preload is least
   privilege; the main gate remains the authoritative defence if that bridge is
   accidentally widened later.

The negative security fixture invokes `lin:invoke('delete_node', …)` and
`lin:invoke('get_projection')` from the real launcher sender and requires both to be
rejected without reading or changing the document. Positive fixtures prove the
launcher can still query/execute admitted actions and the Settings/provider windows
retain the app capabilities they use.

The shipped code already demonstrates the correct pattern:
`launcher:createContextCapture` accepts only an optional note while **main holds
the authoritative `ExternalContext`**, and the intent is validated at the seam
before it reaches durable storage. The registry follows it exactly:

0. **The ref has to be created before anything can name it, and that is the
   security boundary.** A context-menu seed creates its record after validation; a
   launcher open creates its record synchronously with an empty fixed set and a
   main-owned pending ambient slot, before either async context path resolves. Main
   cannot infer which visual row was right-clicked, the
   live selection, panel identity, `rowExpanded` or `isPinned` from the projection —
   those are renderer facts today (`NodeContextMenu.tsx:63-80`,
   `OutlinerItem.tsx:2500-2516`). But letting a renderer post a finished
   `ActionInvocation` would let it author the very fields main is supposed to
   attest. So the main renderer sends an **`InvocationSeed`** — raw facts only, on a
   **sender-checked** channel — and **main** validates the ids, derives each node's
   row/content/canonical-surface facets plus selection roots, constructs the object
   set, and mints `origin`, `attestation`, lifetime and consumer. Page, node-search, system-node and
   app-surface objects are **constructed inside main** and never arrive over IPC as
   authored objects. A draft object is constructed by main from the launcher's
   sanitized, bounded input; it cannot carry an arbitrary object ref. The launcher
   can neither submit a seed nor upgrade one; wrong-sender and forged-selection /
   `workspace` attempts are rejected, and both are tested. For a launcher invocation
   the validated seed is input to the main-owned ambient transition, never a second
   invocation and never a renderer-authored membership patch.
1. Main returns
   `{ invocationRef, openSeq, ambient, fixedItems, resultItems, menuActions }`.
   Launcher `ambient.state` begins `pending`; `fixedItems` may therefore be empty
   while the ready empty-query generation already contains Today and the other
   stable objects.
2. Each input change sends the bounded `ObjectQueryRequest`; main replaces the
   result generation and `draftText` as D1a specifies. A query response can present
   objects but cannot execute one or make it active.
3. External capture or a sender-checked in-app seed resolves through
   `AmbientContextResolved`; an in-app path first returns the main-issued tuple in a
   sender-checked `InAppAmbientSeedResponse`. Main installs/replaces the fixed object
   only for the matching opening and pushes `AmbientContextChanged`. The launcher
   cannot answer the seed request or invoke the transition.
4. Resolving an object-valued default installs a resolver-owned argument generation;
   opening a parameter picker uses `ParameterObjectQueryRequest`. Both mint refs in
   the exact action/subject/parameter slot rather than borrowing a main-list ref.
5. The user picks → the renderer sends an `ActionRequest`: **action id, invocation
   ref, subject ref and correlated typed arguments**. Nothing else.
6. **Main re-evaluates** that tuple against the latest projection, proves the subject
   ref against current subject membership and every object-valued argument ref
   against its exact ready argument slot, then produces and executes the effect
   itself.

So `ActionEffectPlan` only ever travels **main → renderer**, which is the trusted
direction. A current subject whose state/arguments changed returns `reEvaluated`;
a removed subject/result generation or stale/cross-slot argument returns `stale`
with no invented presentation. Forged requests are rejected instead of mutating.

**`InvocationRef` needs an origin, a per-part attestation, and a phase — or the rule
above is not implementable.** In the command-surface path the renderer that *sends*
the request is always the launcher; the main renderer only *pushed the context*
(D4). So "the invoking surface is the main renderer" cannot key off `event.sender`:
that makes the toolbar permanently absent from the searchable surface, while letting
the launcher supply `workspace` erases the fence.

**Most objects are main-origin, and an earlier draft could not represent them.**
Out of app, main captures the page and owns its `ExternalContext`, main returns the
node matches, and the empty launcher offers system-node and app-surface objects with
no renderer-supplied subject at all — and the main renderer may not even exist, since
its macOS window can be closed while the prewarmed launcher and the global hotkey
live on. Requiring `attestedBy: 'mainRenderer'` on every record would have forced a
choice between inventing provenance and deleting the plan's headline surface.

So provenance attaches to the **parts that need it**, not to the envelope:

- **`origin: 'main' | 'mainRenderer'`** — main-origin records are first-class.
- **`attestation`** — present *iff* the invocation carries `view` or `workspace`
  facts,
  minted from a **sender-checked main-renderer IPC**, and carrying
  `webContentsId` + `renderGeneration` so a **reload invalidates it** rather than
  leaving a stale bit admissible. The launcher can never supply or upgrade these
  parts; an attempt is rejected, not merged.
- **`consumableBy`** — main hands a launcher-consumable ref to the *current*
  opening. Submitting against a ref you were not handed fails.

Admission then reads: an action needing `view`/`workspace` context requires a
**current** attestation; an action on a main-resolved node, page, draft or app-surface
subject requires none; and every object-valued argument requires a current
action/subject/parameter-scoped generation regardless of its backing object's
identity. The toolbar exception therefore holds in the action panel **iff** the main
renderer attested the bit — and `open` on the Today subject works with no main window
at all, while Today used as a capture destination still needs its separate admitted
argument ref.

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
| `confirming` | **the challenge-bearing request — this *is* acceptance** | `executing`, atomically, after token + subject + argument validation |
| `confirming` | `confirmationCancelled` | `live` — challenge revoked in the same atomic step |
| `confirming` | challenge TTL expiry | `live` — challenge revoked |
| `confirming` | subject or argument mismatch on redemption | `live` — challenge revoked; current subject is re-presented, removed subject returns `stale` |

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
to advance a native confirmation is rejected, not merged. Main revalidates the
subject and arguments
at acceptance, the same as flow A.

This is also why `readyToCommit` is gone: both flows commit straight from
`confirming` — flow A on the redeeming request, flow B on main's own acceptance —
so a fourth phase existed only to be transited through.

**Shared rows, both flows:**

| from | event | to |
|---|---|---|
| `live` / `confirming` | `objectRemoved` / `selectionMemberRemoved` | same phase with membership atomically rewritten; if the confirmed subject was removed/replaced, challenge revoked and phase returns to `live` |
| `live` / `confirming` | main-owned `AmbientContextResolved` for the current opening | same phase with the ambient fixed slot atomically installed/replaced; a replaced confirmed subject revokes the challenge and returns to `live` |
| `live` / `confirming` | accepted parameter query | same phase with only the named argument slot replaced; a challenge using its old generation is revoked and returns to `live` |
| any phase before `executing` | `abandoned`, dismissal, superseding open, attesting-renderer reload, invocation TTL | `spent` (terminal) |
| `executing` | settlement — `completed` / `failed` / `indeterminate` | `spent` |
| `executing` | dismissal · superseding open · reload | **`executing`** — UI lifetime events must never invalidate an in-flight plan |
| `executing` / `spent` | late ambient or query completion | unchanged / `superseded` — a frozen plan and terminal record cannot gain membership |

The invocation is **claimed on entering `executing`, before step 0 is dispatched** —
not at completion. A second submit against a claimed record is rejected.

**PR 1 has to wire the cancel event, and it is not a behaviour change.** The shipped
`ConfirmDialog` routes Cancel, Escape and backdrop to `onCancel`
(`ConfirmDialog.tsx:38-57`), and the menu's handler only clears local state
(`NodeContextMenu.tsx:589-597`) — main never learns. It now also emits
`confirmationCancelled`. This event itself has no visible delta; the approved-delta
differential still requires the confirmation copy, subjects and eventual effect to
match. What changes is that the record returns to `live` and the challenge dies with
it.

**Chip removal is a real membership transition, not a local erase or whole-opening
abandonment.** D4 lets the user drop one context object and continue searching.
Main validates the named fixed object/member, rewrites the aggregate when needed,
and invalidates every removed or replaced ref. Treating that event as `abandoned`
would secure the old ref only by killing the still-visible opening; treating it as
renderer-local would leave the ref admissible. The named object events avoid both
failures.

**Every explicit dismiss path is phase-aware.** Today Esc goes straight to
`launcher.hide()` (`LauncherApp.tsx:189-193`) and every hide bumps `launcherOpenSeq`
(`main.ts:1685-1694`) — which, mid-plan, would either invalidate the ref between two
steps or destroy the only surface that was going to report the outcome. So while a
record is `executing`, Esc and the global toggle **mark dismiss-after-settlement**
rather than hiding, alongside the blur guard that is already armed. Before
`executing`, they invalidate and hide as they do today.

Tests: two simultaneous submits, two simultaneous first-leg confirmations, Esc and
global-hotkey dismissal while step 0 is pending, dismissal between two steps,
**cancel then run a different action from the same menu opening**, **redeem after
cancel**, **redeem after challenge expiry**, **submit through a ref whose chip was
removed**, selection-member removal with the old aggregate ref replayed,
out-of-order object-query completion, superseding query, old draft replay,
stale parameter candidate replay, a candidate reused across action/subject/parameter
slots, Today subject-ref substitution for a capture-destination ref, a main-list
query while the page's resolver-owned Today argument stays valid, slow ambient
context after input, stale-opening ambient replay and a late in-app seed,
**PR 1 Confirm-to-effect end to end**, **native Cancel with no token ever
minted**, **a launcher attempt to advance a native confirmation** (rejected), spent-ref replay, wrong sender, superseded open, a launcher attempt to add
`view`/`workspace`, attestation invalidated by a main-renderer reload, and `open` on
an app-surface object plus a node-result object **with the main window closed**. The
IPC suite separately proves the launcher cannot call either `get_projection` or
`delete_node` through `lin:invoke`.

**Two admissions for renderer-owned facts, both bounded.**

**(a) Renderer-side effects.** Facts main cannot know — `isPinned` is localStorage
workspace chrome (`useWorkspacePinnedNodes.ts`) — may be renderer-supplied when the
resulting steps are also renderer-side: **`workspace` and `reveal`**. Pin cannot
corrupt the document because pinning never touches it.

**`clipboard` is deliberately not on that list, and needs no exception.** It is a
`main` step (see the effect union): main resolves the bounded text from the
authoritative invocation and projection and writes it itself, precisely because the
locked-down launcher cannot read the document. Listing it here would have been
false twice over — routing *Copy text* toward a renderer that cannot obtain the
text, and implying renderer-owned facts may feed a main-side write.

**(b) One named parameter to one command.** The toolbar visibility action genuinely needs
`rowExpanded` to decide *whether the document changes at all* (see D1's table), so
"a command resolves entirely from main-owned state" cannot hold universally without
changing behaviour. Rather than bend the rule silently, it is **listed by name and
fenced by three conditions, all of which must hold**:

1. the `view` facts were **attested by the main renderer** — which is not the
   same as "the main renderer sent this request" (see the provenance rule below);
2. the parameter selects among **view preferences the user can immediately
   change again** — never node identity, never subject membership, never destructive;
3. it is **enumerated in the registry**, not admitted by category.

`rowExpanded` → `set_view_toolbar_visible` is the **only** entry that qualifies
today. The rule this protects is "a compromised locked-down renderer must not
author arbitrary mutations", and a main-renderer-only setter for one view preference
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
   `(actionId, invocationRef, subjectRef, hash(resolved arguments))`**, and the response carries
   the authoritative copy, subject and arguments the dialog must show, so the dialog cannot
   describe one thing while the token authorises another. This is why
   `ActionRequestResult` is a union: the first leg is a *response*, and a contract
   with only inbound requests and terminal outcomes had no way to carry it across
   preload/IPC.
2. **The challenge-bearing request is the acceptance**, and it commits atomically.
   Main revalidates: token unspent and unexpired, the record in **`confirming`**,
   and **the subject and arguments re-resolve to the same set** — so a dialog shown for three
   nodes cannot commit against thirty. Any failure revokes the challenge and returns
   the record to `live`.

**The security claim for flow A is stated exactly, because a challenge alone does
not prove a human saw anything.** A compromised renderer that *receives* a challenge
can redeem it silently. The challenge closes first-request commits, replay, and
subject/argument substitution between the legs — not "the user consented".

**Flow B (native) exists because that is not enough for the two actions outside
`Cmd+Z`** — *Delete forever* and *Empty Trash* — once a second, locked-down renderer
can name them. It is **not flow A with a different dialog**: it has **no legs and no
token**.

Main raises the sheet (`dialog.showMessageBox`), and **main's accepted sheet
revalidates the subject and arguments and atomically claims `confirming → executing` without ever
creating a `ChallengeToken`.** Nothing is minted, so nothing can be handed to a
renderer, so nothing can be redeemed by one — which is the whole point: a token
would put the deciding artefact back in the hands the sheet exists to bypass. Main
raises it, main observes the acceptance, main executes.

**That change lands with PR 2, not PR 1.** The context menu ships an in-app
`ConfirmDialog` today (`NodeContextMenu.tsx:589-598`), and replacing it with a
native sheet changes presentation, focus, keyboard behaviour and window modality —
which PR 1 cannot mix into its approved-delta parity proof, and which that proof
could not verify (comparing "did a confirmation appear" is exactly the weakening
that would hide it). The timing is not a compromise either: **the threat
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
renderer-only `DocumentIndex`. Applicability is keyed by **subject object kind plus
attested context**, not a loose `scope` label. The node context menu mixes node and
selection subjects with view/workspace facts; the command surface additionally
presents page, draft, system-node and app-surface objects without turning those
objects into action ids.

### D2 — The context menu is an anchored view of the registry

The menu is anchored beside the node. Anchoring is the reason it survives:
**position selects the subject object.** You can never mistake which node a
right-click menu acts on, whereas a centred overlay must state its object in words.

**Filtering is two-layered, and both layers are required.** Main first constructs
the object set for the opening, then the registry walks its canonical menu order and
resolves **one subject per family** from that set:

```
menu.render(
  registry.actionsForObjectSet(currentObjects(invocation), ctx, {
      subjectPrecedence: ['nodeSelection', 'node'],
    })
    .filter(action => action.evaluation.status !== 'absent')
    .filter(isMenuAction),
)
```

`currentObjects` is the main-owned union of `fixedObjects` and the one `ready`
result generation; a context-menu opening has only the fixed node/selection set.
Argument generations are deliberately excluded: a destination/tag candidate can
fill only its declared slot and can never become a menu subject by appearing there.

The precedence is conditional on what the family accepts, not a blanket hiding
rule. With a live multi-selection, selection-capable families (`duplicate`, `move`,
`setDone`, `addTag`, `remove`, `deleteForever`) resolve once against the
selection. Node-only families (`openInSplitPane`, `setPinned`, `sendToAgent`,
`setViewMode`, `setViewToolbarVisible`, `editViewSection`, `editDescription`, `copy`,
`restore`, plus `emptyTrash` on its system node) keep the anchored node subject;
view/workspace-dependent families additionally require their attested facts. Without
a selection the same selection-capable definitions fall back to the node. A naive object `flatMap`
would duplicate rows and change their subjects, so the differential test treats
this resolver as part of the parity contract.

The context-menu invocation carries `node` and `nodeSelection` objects plus attested
view/workspace facts because the shipped menu mixes actions over all of them. It
carries no system-node or app-surface object unless that object is itself the
anchored node (Trash is the obvious example), so *Today*, *Settings* and *Main
window* cannot leak into a right-click menu. No second `scope` filter or special
exclusion list is needed.

**One registry, two projections — and that is the whole seam.** Anchored
(browsable, subject selected by *position*) and the `Actions ⌘K` panel
(searchable, subject selected by a chip or row). They are not two implementations:
the same action family and bound arguments produce the same effect. The main result
list is the complementary **object projection**, not a third action implementation.

**Parity outside an explicit approved-delta list is the acceptance criterion**, and
it is proven by **differential test against the old code, not by a hand-written state
table.** Enumerating every state the current menu distinguishes (selection size,
in-Trash, descendant constraints, node type, field rows, view mode) is itself a
design task; miss one dimension and the proof passes while behaviour changed.
Instead the old menu path stays in the tree for the duration of the PR as the
**oracle**. Both paths render over a corpus of real document states; the comparator
allows only these reviewed deltas:

1. `Move to` candidate ordering/admission changes as specified in D5.
2. Mixed-selection *Toggle done* becomes convergent *Mark done* and *Mark not done*
   variants as specified in D1a.
3. Action copy is normalized: *Send to composer* -> *Send to Agent*;
   *Add/Edit description* -> *Edit description*; *Filter/Sort/Group/Display* ->
   *Edit filters/sorting/grouping/displayed fields*; and the current generic *Trash*
   copy becomes the row-policy-true `remove` variants in D1a. The delete effect and
   step order remain unchanged.

Everything else — presence, order, confirmation, subject set, effect-step order and
failure behavior — must compare equal. The old path is deleted in the PR's final
stage.

### D3 — The command surface searches objects; its action panel searches the registry

- **`Cmd+Shift+Space` summons everywhere; the global `Cmd+K` binding retires.**
  Delete `global.command_palette` (`shortcutRegistry.ts:139`) and the hard-coded
  `Cmd+K` hint on the `/` menu's palette row (`slashCommands.ts:71`). **The
  binding retires; the in-app entry points do not** — the `/`-menu row and the
  sidebar *Search* row are retargeted to summon this panel, since a surface that
  teaches its own keystroke (D6a) must still be reachable by someone who has not
  learned it. Step 12 enumerates every call site.
- **One rendered surface: the existing launcher panel.** `CommandPalette.tsx` is
  deleted. The launcher already covers most of it (node search, open in the main
  window, free-text node creation into Today) but **is not yet a superset**: the
  palette also carries five navigation objects and shows them as its empty-query list
  (`CommandPalette.tsx:102-143`), which the launcher explicitly defers
  (`core/launcher/commands.ts:83-85`). The launcher becomes a superset only after
  the system-node/app-surface providers and ensure-first Today activation ship —
  deleting the palette before then would lose behaviour.
- **Navigation destinations become node objects:** Today / Library / Schema / Saved
  searches / Trash. The existing *Open main window* and *Open Settings* commands
  become `appSurface` objects named *Main window* and *Settings*. All seven resolve
  the same `open` family; there is no `app` action scope, and the legacy
  `LauncherItem.kind: 'command'` arm is deleted. A surface that claims to be the
  universal entry point cannot omit the app's own objects, but it also cannot encode
  those objects inside command labels. Node objects resolve to renderer navigation;
  app surfaces resolve to the main-host `activateAppSurface` effect, which creates or
  focuses the required BrowserWindow even when no main renderer exists. This does
  **not** ban a future first-class
  command object: a Raycast-like tool such as *Search Files* is an identity-bearing
  object whose primary action is *Open Command*. Tenon simply has no equivalent in
  this release, so this plan does not ship an empty command provider or a speculative
  `run` action.
- **Two navigation semantics must be carried over, not re-invented.** The palette's
  Today row runs `ensureTodayNode` **before** navigating — it creates the day's node
  when missing (`workspace-layout.md`: "the in-app command palette uses the same
  ensure-first path"), so `open` on the Today object must ensure and bind the created
  node before navigating. `go` and `navigate` are searchable aliases for `open`
  inside `Actions ⌘K`, not additional action ids or cross-layer main-input terms.
  And in-app navigation re-roots the *active panel in place*, while the launcher's
  path routes through main; the same action family resolves to the in-place effect
  when a current view exists.
- **In-app summon must not read external context.** Today the hotkey classifies
  Tenon itself as `unknown-app`; when the main window is frontmost, skip the
  external capture and resolve the sender-checked in-app seed into the pending
  ambient slot instead (D4).
- **Focus lands where the action points.** `open`, `openInSplitPane` and
  `sendToAgent` leave focus at their destination. Every other action returns focus
  to the editor position it came from, subject to D9's failure rules.

### D4 — The chip is the ambient object, visible and removable

There is **one** concept here, not two. The chip is not "attached context" that
separately happens to be actionable — it is the same `ObjectPresentation` a result
row uses, rendered compactly because ambient context offers it as the implicit
default. In app this is
the focused node or selection (pushed from the main renderer over IPC); out of app
it is the foreground page.

- **Shown as soon as it resolves, and always visible once attached.** The launcher
  opens and accepts input immediately; while ambient resolution is pending there is
  no chip and no invisible attached object. `AmbientContextChanged` installs the
  authoritative presentation without clearing typed text or current results.
- **Removable through main**, because a default is a guess: remove it and the
  surface falls back to global object search with no contextual object. The
  `objectRemoved` transition in D1a invalidates the ref; deletion is never a local
  visual-only erase.
- **The chip is the implicit default; explicit result choice wins.** If context is
  ready at opening, the chip starts active. If it arrives later while activity is
  still implicit, it becomes active even when the user has typed; typing alone is
  payload admission, not result selection. If the user already used `ArrowDown` or
  clicked a current result, or opened an action/parameter/confirmation subpanel for
  the current object, the late chip is installed visibly but **does not steal
  activity**. Replacing an active ambient chip activates its replacement; replacing
  an inactive one preserves the explicit result. This activity cause is renderer UI
  state, not an admission claim: execution still names and validates a ref.
- `ArrowDown` from the input/chip or clicking a result explicitly makes that row
  active. `ArrowUp` from the first row, or `Esc` while a result is active, returns to
  the chip without clearing the input; a subsequent `Esc` dismisses the panel.
  Escape precedence is subpanel → active result → launcher; D9's executing/dwell
  lifecycle overrides it once an action is claimed. A new query generation
  invalidates an active old result and returns activity to the chip when one exists;
  without a chip there is no active object until the new generation is ready.
  Clearing the query follows the same rule.
- **The input is independent payload.** With a page chip active, Enter runs
  `capture(page)` and main supplies the current `draftText` as its note; `Actions
  ⌘K → Send to Agent` supplies the same text as the editable question. The user can
  still choose a matched node or no-match draft explicitly. Thus object search does
  not delete the shipped page + note path or the promised page + question path.
- Parameter pickers preserve the parent action's subject and bind the highlighted
  candidate from that action's current argument generation (D1a); they do not
  replace the active subject. The action bar always names the action for the currently
  active object, never for an invisible subject.
- Carried by ref, not merely displayed — which is what lets the action panel act on
  an object that is not otherwise in the result list.

**A multi-node selection is one aggregate chip** ("5 nodes"), expandable to remove
individually through `selectionMemberRemoved` — not five chips. Main replaces the
aggregate ref after every edit, so replaying the prior selection cannot address the
old set. Five chips overflow a 760px panel and make "remove everything → global
search" ambiguous, and the actions that accept a selection take the set, not its
members.

The aggregate chip resolves **selection-subject actions only**. It does not inherit
the context menu's node-only actions, because that menu has a positional anchor and
the centered surface does not. To use `openInSplitPane`, `setPinned`, `sendToAgent`,
`editDescription`, `copy` or another node-only family, the user highlights that node
object and makes the subject explicit. Thus “the command surface covers the menu”
means every action is reachable for its correct object, not that one aggregate chip
reproduces the anchored menu's composite object set.

**Focus versus selection is not a new rule** — the object resolves through the
shipped `contextMenuSelection.resolveActiveNodeSelection`: the selection wins only
when the focused node is *part of* a multi-selection (collapsed to roots by
`selectedRootIds`), otherwise the focused node alone, with reference rows resolving
to their target. Reusing it is what makes the two projections (D2) agree by
construction instead of by inspection. A selection may have **no safe primary
action**; in that case Enter is inert and the action bar exposes only `Actions ⌘K`.
The model does not invent *Open first selected node* or put a mutation under blind
Enter merely to fill the slot.

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
(`LauncherApp.tsx:26`, `:84-104`) is the pattern to reuse, not reinvent. PR 1 therefore
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

The Raycast model, and **half of it already ships**. A main-list row is a pickable
*thing* — node, selection, external page, draft or app surface — rendered as
`glyph · title · subtitle · right-aligned type label` in one flat list with no
section headers. A registry action is never a main-list object. A **genuine command
may be one**, as Raycast demonstrates: *Search Files* is a named tool and *Open
Command* is its primary action. By contrast, *Open Settings* is merely an app-surface
object and its action fused into one phrase. The current migration removes that
legacy command arm; it does not erase the distinction or reserve fake rows for
future tools. What Enter will do lives in the action bar, not in a compound row title.

**Three uses of “command” stay distinct.** A future UI *Command object* is a
selectable tool with identity; the legacy `LauncherCommandView` compound row is
deleted; and a core `DocumentCommand` remains an internal mutation-protocol step in
an `ActionEffectPlan`, never a surface row. Sharing the word does not merge their
contracts.

| Candidate | Classification | Main object list | Primary behavior |
|---|---|---|---|
| Today / Library / Schema / Saved searches / Trash | system-node object | yes | `open` |
| Main window / Settings | app-surface object | yes | `open` |
| foreground page | external-page object | ambient chip when resolved | `capture` |
| current multi-selection | node-selection object | ambient chip when resolved | none; choose from `Actions ⌘K` |
| unmatched typed text | node-purpose draft object | yes, literal title + *New node* type | `create` |
| Mark done / Move / Add tag | action | no; `Actions ⌘K` only | resolved for active object |
| Raycast-like *Search Files* | future command object | only when a real provider ships | `open`, or a separately justified future family |

| Element | Rule | State |
|---|---|---|
| Main-list row | `ObjectPresentation`, type label right-aligned | current `rowView` is adapted; action rows and legacy compound-command rows are removed |
| Context chip | the same object presentation, compact; implicit default unless a result was explicitly chosen | new |
| Action bar, status/identity zone (left) | app mark + formatted summon hotkey at rest; busy text and the D9 outcome during execution (D6a) | **new** |
| Action bar, right cluster | the active object's optional primary action + `↵`, then `Actions ⌘K` (D6a) | current `primaryActionLabel` is adapted; `Actions ⌘K` is **new** |
| `Enter` | run the primary action when one exists; otherwise inert | adapted |
| `⌘K` / click | open the active object's searchable `ActionPresentation[]` | **new** |

`LauncherItem.actions[]` has been an array since #103 precisely so secondary
actions could return additively (`spec/launcher.md`). PR 2 replaces its ad-hoc
action shape with `SurfaceItemPresentation`; it does not preserve the
`kind: 'command'` union arm merely because that was the first shipped representation.

**The global `Cmd+K` summon retires; the keystroke is relocated** to "show this
object's actions" inside the surface. The main input searches object names; the
action panel searches action names and aliases for the active object. The two
searches never return mixed row types.

**Ordering** makes object retrieval authoritative and creation an explicit fallback:

1. the launcher opens with an ambient slot outside the result list; once its page or
   in-app object resolves, D4 decides whether the chip becomes active or preserves an
   explicitly selected result;
2. a non-empty query searches node, system-node and app-surface objects in one
   ranked result list;
3. when at least one object matches, only those matched objects are returned -- a
   draft never competes with them for the default Enter action;
4. only when no object matches does main synthesize exactly one node-purpose
   `draft` object whose literal title is the entered text; tag-purpose drafts exist
   only inside the `addTag` parameter picker;
5. with no chip and no query, Today / Library / Schema / Saved searches / Trash /
   Main window / Settings are the stable object list.

Every input change uses D1a's `(invocationRef, openSeq, requestId)` query contract.
Accepting the request removes the previous generation immediately; while the new
generation is pending the list cannot render or submit stale rows. A ready response
installs fresh refs atomically. A late response is `superseded`, and a search failure
leaves only fixed objects active until the next query rather than restoring the old
generation. The fixed chip may still execute while retrieval is pending because its
latest `draftText` was admitted synchronously and its resolver-owned argument
generation is independent; a no-chip opening has no blind-Enter subject until the
generation is ready.

There is no final "commands" bucket in this release and registry actions never slot
into the object list. If a real command-object provider ships later, its objects join
the same ranked results instead of returning as a privileged trailing bucket. Any
matched command object suppresses the fallback draft just like a matched node,
system node or app surface.

**Default activity is a fixed rule, never learned:**

- context chip present before an explicit result choice -> the chip is active;
- context chip resolves after typing but before an explicit result choice -> it
  becomes active without changing `draftText` or results;
- context chip resolves after `ArrowDown`/click or while a subject-bound subpanel is
  open -> it appears without stealing activity from the current-generation result;
- selected result is superseded, `ArrowUp`/`Esc` returns from the first row, or the
  query is cleared -> the chip is active when present;
- no chip -> the first current-generation result is active; on an empty query that
  is Today, and on a no-match query it is the one draft;
- removing the active chip promotes the first current-generation result under the
  same rule, or Today after the empty-query generation resolves.

Primary actions are object contracts, not learned behavior: page -> `capture`,
node-purpose draft -> `create`, stored/system node and app surface -> `open`. When
non-empty input matches no searchable object, the draft is the sole result: its row
shows the entered text with the localized type label *New node*, the action bar
shows *Create node* **when that row is active**, and Enter executes
`create(draft, { destination: Today })`. With an ambient chip the user first selects
the draft; without one it is active by default.
It is not a *New node in Today* command row. A multi-selection has no primary
because it has no safe canonical activation.
The page and draft mutations follow an explicit captured object or text the user
just authored; no ambient node mutation ever occupies a blind-Enter slot.

**Arbitrary unmatched text is not a command object.** It is the literal content of
the transient `draft` object, *New node* is that object's localized type label, and
`create` is the action applied to it. A stable *New node* command object would be
justified only if Tenon later ships an independently discoverable creation tool with
its own interaction surface or secondary actions; the inline no-match fallback does
not need one.

**Recents were considered and dropped.** The superseded plan carried "persist the
last N capture/jump targets, surface as empty-query quick rows" as a must-keep
contract. It is not carried here: with capture landing in Today (D9) there is no
destination to remember, and the empty state now has real content (navigation
entries) rather than needing filler. Recency already earns its keep where it
belongs — inside search ranking (`nodeAccessStore`). Recording the drop so it is a
decision, not an omission; re-adding it later is an object provider, which is the
point.

Rationale for keeping it fixed: a user who types-and-blindly-Enters always exists.
`create(draft)` and `capture(page)` are safe primaries because the row reflects text
the user just authored or a page they explicitly summoned the launcher over. An
ambient node or selection mutation is not: it would surprise the user by changing
pre-existing data, so those objects never receive a mutating blind-Enter primary.

### D6a — Panel presentation, the input guard, and the first open

Added 2026-08-06 (PM-directed, from the systematic launcher review). D6 fixes the
semantic slots; this section fixes the panel's visible anatomy so PR 2 and the
pre-PR-2 hardening pass (`archive/launcher-interaction-hardening.md`, shipped
**#497**) implement **one** visual language. Token/material authority remains
`design-system.md`; nothing here introduces a non-token value. **This anatomy is
now largely as-built** — `spec/launcher.md` → *Footer* is its authority; what
remains for PR 2 is named at the end of this section.

**The action bar is a slim hint bar, never a button row.** When this was written
the bar's one element was a bottom-right ghost button restating the selected
row's full title — the list said *Open main window* and the button repeated it.
#497 replaced it with the two zones below; the compound rows themselves die in
PR 2 (D6). The bar has two zones:

- **Left — identity + status.** At rest: the app mark plus the **formatted summon
  hotkey** (`formatHotkey`, e.g. `⌘⇧␣`) in `--text-tertiary` at `--font-meta`.
  This is deliberate, not decoration: with the sidebar *Search* row (shipped in
  #497 — `Sidebar.tsx:137`) a mouse-first user reaches this panel
  without ever knowing the keystroke, and the identity slot is where the panel
  teaches it (the Raycast identity slot, put to work). During execution the zone
  carries the busy text, then D9's outcome for the dwell — success confirmation in
  `--text-secondary`, failure reason in `--status-danger` (status color carrying
  status meaning, B4). Status never renders inside the primary control.
- **Right — the hint cluster.** The active object's primary action as its D8 verb
  label + `↵` kbd chip, then `Actions ⌘K`. Both are real buttons (click = the
  keystroke; mousedown-preventDefault keeps the input focused) styled as hints:
  `--font-meta`, `--text-secondary`, no fill at rest, quiet `--fill-2` hover, no
  control-height bulk, no hand cursor (B10). The primary label never restates the
  row title (D8); when the active object has no safe primary, the cluster shows
  only `Actions ⌘K` (D4).

No divider — whitespace separates, the ratified B-clean footer. The bar keeps the
same roomy inset as the input header so the panel stays balanced top↔bottom.

**Rows stay one flat list — reaffirmed, not revisited.** With the object model
there is no command/object taxonomy left to group: every row is an object and the
right-aligned type label does the classification. Section headers return only if a
future provider makes the list genuinely heterogeneous, as a plan-level decision.

**The first open is the empty-query list doing its job.** A new user's first
summon shows the placeholder ("Capture, search, or run a command…"), the seven
stable objects (D6 ordering rule 5), and a bar that names the primary action and
the keystroke that summoned everything. **No onboarding banner, no coach marks, no
first-run chrome** — the fixed golden-rectangle panel is furnished by real
content. This is also what retires the shipped first-open defect (two lonely
command rows adrift in a 470 px window); the fix is the content model, not a
resized window. The one first-run surface that remains is the existing
Accessibility/Automation remediation banner, unchanged.

**IME composition guard — a hard requirement, not polish.** While an IME
composition is active (`isImeComposingEvent`, the shipped palette guard —
`imeKeyboard.ts`), Enter, ArrowUp/Down and Escape belong to the IME: the panel
neither runs an action, moves activity, opens the action panel, nor dismisses.
The guard applies to the main input, the `Actions ⌘K` panel, parameter pickers,
and any text input a confirmation carries. The launcher had **no** such guard
when this was written — committing a pinyin candidate with Enter fired the active
row — and this plan's own contract tests would not have caught it;
`launcher-interaction-hardening` shipped it on the current surface in **#497**
(`LauncherApp.tsx:184-188`). PR 2 carries it forward into every new input, and
AC-16 exists so the new surface cannot regress it.

**Inherited from the pre-PR-2 hardening pass (#497, merged 2026-08-07).** That
plan implemented this bar anatomy early on the shipped surface (same classes and
tokens in `styles/launcher.css`), so PR 2 inherits the CSS and replaces only the
JSX it rewrites anyway. What is **still PR 2's** in this bar, stated so the
"inherited" claim cannot be read as "already done":

- the **`Actions ⌘K` control** in the right cluster — #497 shipped only the
  primary hint;
- the primary label's **source**: today it comes from the item's own
  `LauncherItemAction`, and it must come from the registry's resolved
  `ActionPresentation` for the active object (D6/D8);
- the **status zone's content**: #497 hand-wired "Saving…" / the failure line for
  the capture path only; D9's result state replaces it for every action, and owns
  the dwell and the blur guard behind it.

**There is no interim empty-query Enter wait to delete.** Earlier revisions of
this section told PR 2 to remove that stopgap; it was **withdrawn at the review
gate rather than shipped**. The shipped authority says so itself —
`spec/launcher.md:148-149`: *"A renderer-side wait was built and then removed"*,
and `:156-157`: *"The race is that plan's to close (D6a); the launcher does not
carry a stopgap for it."* So PR 2 inherits nothing here. Closing that race at its
source — the synchronous invocation open, pending ambient slot and synchronous
`draftText` admission (D1a/D1b) — is PR 2's own work, not a cleanup of someone
else's, and it retires that spec section (step 13).

### D7 — Hidden without a subject; shown with a reason when a predicate fails

Pure `when`-clause hiding (the VS Code model) has a dead end in a *searchable*
list: you type "move", get nothing, and cannot tell whether the action does not
exist or merely does not apply right now. VS Code survives that because its command
names come from documentation; this action set is learned by exploration. So two
tiers:

- **`status: 'absent'`** — no subject object of a supported kind -> **hidden**.
  Opening an action panel must not present a screen of things that cannot run.
- **`status: 'rejected'`** — a subject exists but a predicate refuses it -> shown
  **with its `reason` in the searchable action panel** ("Move to — unavailable in
  Trash"), not silently dropped. A reason teaches the rule; a disappearance teaches
  distrust.

These are the two non-applicable states of `ActionEvaluation` (D1a). They exist as
distinct variants *because of this rule*: a single empty subject list collapses them
and carries no reason.

The context-menu projection maps `rejected` back to its shipped disabled row and
existing label; it does not append a new reason and thereby violate PR 1 parity.
Inside the command surface the reason-bearing treatment applies only to the
`Actions ⌘K` list for the active chip or row; the main object list itself is never
padded with rejected actions.

### D8 — Action naming is part of the contract

In a menu, position and icon carry meaning; in a searchable list only the name
does. Every static object name, object type label, action family and resolved action
variant gets reviewed copy in **both** locales (`spec/i18n.md`). User-authored node,
draft and page titles are `literal` names: they render exactly as captured or typed
and are never translated. Names are reviewed as a set, not one at a time.

**Object rows never carry their activation inside the title.** The row is *Today*
and its primary action is *Open*; the row is *Settings* and its primary action is
also *Open*. A genuine tool named *Search Files* would still show a separate *Open
Command* action. There is no *Go to Today*, *Open Settings*, *Capture page to Today*
or *New node in Today* main row.
Today is a bound destination object for `capture` / `create`, not prose embedded in
their ids. `open` is the one activation family; `go` and `navigate` aliases keep the
action vocabulary discoverable inside `Actions ⌘K` without creating duplicate
actions or restoring compound main-list search.

An action label may still name a **fixed semantic boundary** when that is what
distinguishes the operation: *Open in split pane*, *Move to Trash*, *Remove field
value*, *Empty Trash* and *Send to Agent* remain action variants. The two removal
labels resolve from the `remove` family and row policy; neither is an action id.
They never interpolate the active subject's title, and their request still carries
the subject object separately.

State and finite choices become typed arguments: `setDone(true)` presents *Mark
done*, `setPinned(false)` presents *Unpin*, and `copy('nodeId')` presents *Copy node
ID*. The argument must describe the desired outcome; runtime toggles are forbidden.
The `create` family presents *Create node* for a draft object; the raw draft text is
the object title, not interpolated into the action name.

**Search matches both locales at once, regardless of UI language.** This user
thinks in English command names and runs a Chinese interface; a surface that only
matches the active locale's string would swallow half of what they type. The
locale-independent family id, aliases and both display names are all matchable — the pattern
`filterSlashCommands` already uses (English label + keywords as a locale-independent
base, plus the localized label). For a `localized` object name, object search matches
both locale values; for a `literal` name it matches the one user-authored value.
Action names are matched only inside the action panel.

### D9 — Every panel-fired action reports its result; capture closes its loop

**The general rule first:** the panel does not activate the main window and
dismisses itself when an action runs, so **any** action fired from it must produce
an observable completion: either a visible result signal or arrival at the action's
destination. `move(node, destination)` has exactly the same problem as a capture —
the surface vanishes and the user may not be looking at the window where it landed.
One rule, not a capture special case.

**One window lifecycle, because two earlier decisions contradicted each other.**
"Focus returns immediately" plus "confirm inside the panel" cannot both hold: the
launcher routes `blur` straight to `dismissLauncher()`
(`launcherWindow.ts:118-124`), so returning focus at commit destroys the very
surface meant to show the confirmation — precisely in the background case the
signal exists for. The lifecycle is therefore explicit:

1. **Before step 0 is dispatched**, the panel enters an **executing** state and main
   arms a **main-owned blur guard**. Arming it after the first step commits was a
   race with two ways to lose: step 0 itself can fail (a command can throw, a
   renderer step can never acknowledge), leaving no committed step to enter the
   state *from*; and any destination step that focuses the main window would trip
   the launcher's shipped `blur → dismissLauncher()` handler
   (`launcherWindow.ts:118-124`) and destroy the panel before its outcome could be
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
them.** A blanket restore means `open(node)` from another app raises Tenon and then
hands focus straight back to that app, and *Send to Agent* reveals the composer only
for dismissal to take the user away from it — the two actions whose entire purpose
is to move you somewhere.

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
prior app refocused, in that order), `open(node)` from another app (Tenon focused at
the destination, invoker **not** restored), and `sendToAgent(page)` from another app
(rail revealed, focus in the composer).

**"Once the effect exists" is doing real work in that sentence.** An action
carrying `confirm` (D1) produces no effect until confirmation resolves, so
fire-to-commit applies *after* the confirmation, not instead of it. *Delete
forever* and *Empty Trash* keep their dialog in both views — they are outside
`Cmd+Z`'s reach, which is exactly why they were given one.

- **Today is the bound destination object.** `capture(page, { destination: Today,
  tag? })` and `create(draft, { destination: Today })` use the same system-node
  object model and backing identity that appears in search, but **never borrow that
  row's subject ref**. When each action presentation resolves, main mints Today in
  its `destination` argument slot. A page's resolver-owned generation survives note
  queries; a draft's is removed with that draft subject. Cross-slot or stale Today
  refs are rejected before effect construction. For page capture, main builds the real
  `CreateCaptureInput` from its authoritative `ExternalContext` plus the invocation's
  bounded `draftText`. The existing pure builder is factored into a
  destination-independent capture template and final input materialization, so the
  plan can attach the bound `input.destinationParentId` without an invented node id or a
  second metadata builder. The executor resolves that leaf before dispatch. A
  renderer never authors capture metadata or command input. There is no destination
  picker and no Inbox.
- **The existing page + note path remains the blind-Enter path.** With an ambient
  page chip, typing does not switch subjects: Enter captures that page and uses the
  input as its note whether the same text matches another object or produces a
  no-match draft. `ArrowDown` or click is the explicit choice to act on a result;
  `ArrowUp`/`Esc` returns to the page. If capture is slow, the user may type first;
  the later chip preserves that admitted text and becomes active only when no result
  was explicitly chosen, per D4. This is the brownfield requirement inherited from
  `launcher:createContextCapture({ note })`, not a new shortcut.
- **Success is visible.** Capture currently resets and hides with no confirmation
  (`LauncherApp.tsx:131-138`) — when Tenon is in the background the user gets no
  evidence at all. Show a brief confirmation before dismissing.
- **One optional user tag object at capture time.** Findability comes from tags and
  search, not from location. (The capture-kind tag `#article`/`#video` → `#capture`
  already exists; what is missing is *the user's own* tag.) The effect plan is
  explicit rather than a capture callback: `ensure_date_node → create_capture`
  (bound destination, bind new capture) `→ apply_tag` (bound capture id, existing tag
  id). A tag draft inserts `create_tag` **between** `create_capture` and `apply_tag`
  and binds its result into the final step. Step failure stops the plan under the
  same partial-commit/result rules
  as every other multi-step action; no automatic retry can duplicate the capture.
- **`Send to Agent` is a registry action, not a new AI surface.** It raises the
  main window, reveals the rail, and stages the subject object *and main's current
  invocation `draftText`* — the user edits and submits. The action request cannot
  replace that text with a second payload. Carrying the typed question is not a
  nicety: dropping it would mean the one entry point that works from outside the app
  silently discards what the user wrote.

  **A foreground page object contributes context, not a user message** (PM,
  2026-08-03). A node subject is already expressible as a `nodeReference`, but an external page is not
  one of `ThreadUserContent`'s three kinds (`text` / `attachment` / `nodeReference`)
  — and it should not become one. It enters through the channel the runtime already
  has for exactly this: a renderer-supplied **`additionalContext` entry**, rendered
  inside `<system-reminder><context-evidence>` by
  `ContextProjector.projectAdditionalContext` (`ContextProjector.ts:746-760`),
  under the `additionalContext` evidence kind.

  Three properties make this the right channel rather than a workaround:

  - **No protocol change.** `RendererTurnStartRequest.additionalContext` already
    exists (`protocol.ts:1379-1381`), so this plan stays a *consumer* of
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
screenshot tier. Read nothing moves the ambient slot from `pending` to `none`: no
chip, and the surface degrades to a plain note. Per A12 this path degrades; it never
throws on the user's action.

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

Parity outside three approved deltas, mechanically proven. **The confirmation UI is
not touched here** — the shipped `ConfirmDialog` stays, and the native sheet lands
with PR 2, whose threat model is what motivates it (D1b). The allowed differences
are exactly D2's list: convergent `Move to` retrieval, convergent mixed-selection
Done setters, and normalized action copy. Everything else remains strict parity.

1. **Contracts in `src/core/actions/`** (D1a) as compiling TypeScript with codec
   tests — mutable subject membership, action/subject/parameter-scoped argument
   generations, evaluation, presentation, request, nested-path effect binding — and
   the main-owned admission path (D1b). View facts contain
   `visualRowId`/`rowExpanded`; workspace facts contain only `isPinned`.
2. **Predicates move to core** (D1). The stage-0 spike, done before approval,
   found no renderer dependency that survives tracing: `rowMap` is a cache with an
   existing derivation fallback, `actionPolicy` derives from the projection, and
   the one predicate reading a pane root belongs to an action outside the migrated set.
3. **Populate the registry with the entire existing node-menu action set and its
   normalized bilingual presentations.** This is the point of PR 1: the compiler,
   not a document, decides whether the contracts can express *Pin* (workspace
   chrome), *Copy* (clipboard), *View as* (view), *Delete forever* (confirmation),
   *Move to* (parameter), row-policy-correct `remove` variants and the explicit
   `setDone(true | false)` variants.
4. **Re-render the context menu as a registry view**, differentially proven against
   the old path (D2), which stays in the tree as the oracle until the last commit.
5. **Ship the three approved deltas** — route `Move to` through the shared retrieval
   kernel (D5), make a mixed Done selection converge on the requested target state,
   and replace implementation-shaped action copy with D8's family/variant names,
   including the row-policy-true `remove` labels.

**Why this is a complete feature and not groundwork.** It has a real consumer (the
context menu), a mechanical proof (differential vs the old path plus an allowlist),
and it ships corrections users meet immediately: *Move to* currently slices ten
matches in document order with no ranking, and *Toggle done* does not converge for
a mixed selection. It is the `#451` pattern — freeze the observable surface, prove
every unapproved difference absent, build on it — which carried a 4,700-line move
to zero review findings.

**It touches no agent or composer file.** It now does touch both locale catalogs for
the approved copy normalization, so it must follow/rebase onto #488 (Collision
self-check); the earlier "no locale file" claim is no longer true.

### PR 2 — the command surface and the capture loop

6. **Close the launcher capability boundary first** (D1b): add the dedicated minimal
   launcher preload entry, register sender capabilities in main, reject launcher
   access to generic `lin:invoke`, and sender-check every `launcher:*` handler. The
   negative `get_projection` / `delete_node` tests pass before the registry is
   exposed to this renderer.
7. Replace the launcher's ad-hoc `LauncherItem` union with the shared object
   presentation: providers for external page, draft, node result, the five system
   nodes and the two app surfaces; delete the legacy `kind: 'command'` arm and
   reclassify *Open main window* / *Open Settings* as objects (D3/D6). The main
   input searches only objects through the atomic
   `(invocationRef, openSeq, requestId)` generation contract, synthesizing its draft
   only when none match; `Actions ⌘K` searches the active object's actions. Create
   the launcher invocation synchronously with a pending ambient slot, then install
   external or sender-checked in-app context through the main-owned, `openSeq`-bound
   transition. Implement `activateAppSurface` in main and prove both windows open
   with the main window initially closed.
8. Add the in-app seed path, aggregate object chip and main-owned membership edits.
   Keep `draftText` independent of subject selection and preserve it across late
   ambient resolution. A late chip becomes active only while activity is implicit;
   `ArrowDown`/click protects an explicitly selected result, and `ArrowUp`/`Esc`
   returns to the chip. Add optional-primary Enter behavior, focus completion and
   result signal (D4/D9). Render the D6a bar anatomy (identity/status zone,
   hint cluster) inheriting #497's CSS, add the `Actions ⌘K` control, source the
   primary label from the resolved `ActionPresentation`, and carry the IME
   composition guard into every new panel input (D6a).
9. Close the capture loop with a resolver-installed Today argument object, optional
   tag candidates in their own argument generations, nested `create_capture`
   binding/producer, `Send to Agent`, and its `PendingComposerContext`. Preserve
   page + note capture under slow context and immediate query invalidation, and add
   page + question handoff as an explicit keyboard E2E flow (D9).
10. **Declared user-visible change:** replace the in-app `ConfirmDialog` with a
   main-owned native sheet for *Delete forever* and *Empty Trash* in **both** views
   (D1b). It belongs here rather than in PR 1 because the threat it answers — a
   locked-down renderer naming an action that `Cmd+Z` cannot reach — arrives with
   this PR. Verified light + dark, with focus and keyboard behaviour.
11. **If searchable *Indent* / *Outdent* are wanted, they are a declared PR 2
   addition, not a side effect.** They are keyboard-only today, so exposing them
   requires: a **surface-exposure rule** so they appear in the searchable view
   without leaking into the context menu (which would break PR 1's differential
   after the fact); carrying and attesting the renderer's **`selectionRootId`**,
   since main cannot recover the chosen pane root; and encoding the shipped
   keyboard behaviour — selection restoration and expansion adjustment
   (`useWorkspaceKeyboard.ts:521-565`) — which a command-only effect does not
   preserve. Tests must cover nested and transcluded panes. **Not in scope unless
   explicitly ratified**; the plan does not smuggle it in through a field.
12. **Retire the in-app palette — and every consumer of it.** Deleting
   `CommandPalette.tsx` alone does not compile, and deleting the `global.command_palette`
   binding alone silently breaks a surface #497 just shipped. The work queue is
   `rg -n 'command_palette|CommandPalette' src tests docs` — **the whole tree, not
   `src/renderer/ui/`**, which is how an earlier revision of this table lost the
   handler that actually opens the palette. Re-derive it at implementation start;
   as of 2026-08-07 it is:

   | Site | What it is | What PR 2 does |
   |---|---|---|
   | `src/renderer/ui/CommandPalette.tsx` | the surface | delete |
   | `src/renderer/ui/App.tsx:9`, `:681-690` | mount + `ui.commandOpen` + `commandRestoreFocusRef` | delete the mount and the UI state it exists for |
   | **`src/renderer/ui/useWorkspaceKeyboard.ts:220`** | `matchesShortcutEvent(event, 'global.command_palette')` → `setCommandOpen(true)` — **the handler the binding actually fires**, and the only keyboard path that sets `commandOpen` | delete with the binding; without this the `App.tsx` row leaves a caller of deleted state |
   | `src/renderer/ui/interactions/shortcutRegistry.ts:48`, `:139` | the `ShortcutId` union member **and** the `⌘K` definition | delete both — the keystroke lives on inside the panel as *Actions*. Deleting `:139` without `:48` leaves a dead type; deleting `:48` is what makes every stale caller fail to typecheck, which is the point |
   | `src/renderer/ui/Sidebar.tsx:137` | the sidebar *Search* row's `formatShortcutHint('global.command_palette')` | **retarget to the launcher summon binding**, so the hint re-derives from the surviving shortcut instead of resolving to nothing |
   | **`tests/renderer/sidebarSearchRow.test.tsx:133`** | the existing guard: rebind the registry entry, assert the row's hint follows it — written precisely so a hard-coded `⌘K` cannot survive | retarget to the summon binding. It is the guard on the behaviour this step's headline decision changes, so it must keep failing for a hard-coded hint |
   | `src/renderer/ui/interactions/slashCommands.ts:67-73` | the `/`-menu entry, incl. its stale `shortcutHint: 'Cmd+K'` and its hard-coded English `label` | **keep the entry, retarget it to summon the launcher** (ratified below); drop the hard-coded hint |
   | **`src/core/i18n/messages/en.ts:941`, `zh-Hans.ts:865`** | `slashLabels.command_palette` — the row's display label in both catalogs | re-copy per D8 in both locales |
   | **`tests/renderer/rowInteractions.test.ts:1315`** | asserts `filterSlashCommands('')`'s id list ends with `command_palette` | survives a label-only change; update if the id is renamed |
   | `src/renderer/ui/NodePanel.tsx:549`, `src/renderer/ui/outliner/OutlinerItem.tsx:1208` | the two `/`-menu execution branches that set `commandOpen` | summon the launcher instead |
   | `src/renderer/ui/outliner/SlashCommandMenu.tsx:39` + the **two** `enabledSlashCommandIds` lists (`NodePanel.tsx:708`, `OutlinerItem.tsx:2494`) | the entry's icon and its per-surface enablement | unchanged, since the entry survives |
   | `src/renderer/ui/App.tsx:383` | a comment — *"mirrors the in-app `CommandPalette` jump"* — describing the panel-jump path by analogy to a component that will not exist | re-word to describe the behaviour directly |

   **Ratified (PM, 2026-08-07) — the `/`-menu entry is retargeted, not deleted.**
   It and the sidebar *Search* row answer the same need: a mouse-first or
   menu-first user who never learned the keystroke. D3 retires the `⌘K`
   *binding*, not the in-app entry points to the surface; deleting the entry would
   remove an entry point while the plan's own D6a argues the panel must *teach*
   its keystroke. Its label is re-copied under D8 (the object/verb rule) in both
   locales rather than remaining *Command palette*.

   **The old menu oracle is not deleted here — PR 1's final step already removed
   it** once equivalence was proven.
13. **The palette's CSS, guards and spec entries go with it (A6/B11).** Retiring a
   shipped surface is not just a component deletion, and the deletions must be
   made deliberately rather than discovered as red tests:

   - **CSS + guard.** `.command-palette` exists in two sheets
     (`styles/overlay-palette.css:12`, `styles/popover-command.css:31`) and is
     named in **three** places in `tests/e2e/typography-tokens.spec.ts`
     (`:125`, `:135`, `:1139` — the level-2 opaque-overlay guard). Removing the
     selector from the guard is a B11 *narrowing* of the exception set, not a
     relaxation: the launcher panel is a different tier (vibrant system glass,
     `design-system.md:185`), so it does not inherit the entry.
   - **`spec/launcher.md`, three sections.** *Footer* and *"Action labels are
     verbs"* currently ratify the as-built compound labels *Capture page to
     Today* / *New node in Today*, which D6/D8 replace with an object row plus a
     verb (*Capture* / *Create node*). AC-03's locale guard rejects those exact
     strings, so leaving the spec as-is puts a shipped authority in direct
     conflict with a shipped guard. **And *"Known gap: Enter before the context
     lands"* (`:141-158`) retires by the same argument** — it documents the
     show→context race as knowingly unmitigated and says outright that *"the race
     is that plan's to close (D6a); the launcher does not carry a stopgap for
     it."* PR 2 closes it, so the section describes a gap that no longer exists.
   - **`spec/workspace-layout.md`.** The palette is load-bearing in its focus and
     overlay model, not just prose: the Search row (`:970`), the ensure-first
     Today path (`:1102`), `focusedSurface = 'overlay'` (`:1037`), and the
     `kind: 'command_palette'` overlay discriminant (`:1058`). Whatever survives
     as the launcher summon must be re-stated there, including the sidebar row's
     shortcut source (`:133`).
   - **`spec/ui-behavior.md:765`, `:809`** name the palette in the `Dialog`
     inventory and the combobox a11y contract, and
     **`design-system/components.md:23`** names `CommandPalette.tsx` as a surface
     consumer of the dialog shell — three inventories of a component that will not
     exist. **`design-system.md:143`** lists the file in the *Editor and commands*
     row of the file inventory.
   - **The design-system rules survive; their examples do not.** The docs use
     "in-app command palette" as the *example* of the opaque elevated tier
     (`design-system/foundations.md:307,310,316,350`,
     `design-system/components.md:74`, `design-system/surfaces.md:223`) — the tier
     still has dialogs in it, so the example is repointed, not the rule rewritten.
     Same for **`design-system.md:185`**, whose exception row scopes itself as
     *"in-app command palettes remain opaque elevated surfaces"*: step 13 cites
     that line as **evidence** the launcher is a different tier, and the clause
     itself goes stale once there is no in-app palette to contrast with.
     `design-system/calibration-audit.md` CA55/CA56 are historical records and
     stay as written.

**The ordering constraint that used to sit here is discharged.** PR 2 was
sequenced behind #483 (composer files) and #488 (locale catalogs, `main.ts`,
`preload/index.ts`); both merged on 2026-08-05/06, and so did #490, #480 and #497.
Re-derive the open-PR file sets at implementation start anyway — PR numbers are
evidence, not a permanent dependency declaration.

### Why the split moved here

The PM originally chose one PR to spend one ratification and one merge. Two full
review rounds later that PR had produced zero code, so the bandwidth argument had
been answered by events. The NO-GO rounds had the same root cause — **a type asserted in
prose cannot be falsified**, so each round fixed the prose and the next round found
the next thing prose could not hold. The split puts the contracts where a compiler
and a differential test can judge them instead.

## Verification

- **AC-01 — Menu parity with approved deltas (PR 1, step 4).** Differential: the old menu
  path is the oracle and both paths render over a corpus of real document states.
  The comparator admits only D2's three named deltas and otherwise requires equal
  presence, ordering, subject set, confirmation, effect-step order and failure
  behaviour. Cousin of #445's golden Item-stream parity — compare against the real
  thing, do not hand-enumerate the states that matter.
- **AC-02 — Retrieval convergence (PR 1, step 5) — scoped to the node-picker consumers this
  plan ships.** The assertion covers `Move to` and the command surface, not every
  entry point: the at-caret paths deliberately keep `candidateRanking.ts`, whose
  label-rank tiers are not the main search-engine rank, so a global "identical
  ordering everywhere" test could never pass and should not be written (D5).
  Separately tested: `MoveToCandidatePolicy` **admits before limiting** (a corpus
  where invalid descendants would otherwise consume the limit and hide a valid
  destination), and its **empty-query ordering** returns candidates rather than
  nothing.
- **AC-03 — Object/action separation (D1a/D3/D6/D8).** Compile-time and renderer fixtures
  assert that every main-list row, chip and parameter candidate is an
  `ObjectPresentation`, every action request binds
  `subjectRef + actionId + typed arguments`, and no
  `ActionPresentation` or legacy `LauncherItem.kind: 'command'` enters the main
  object list. Locale guards reject the compound strings *Go to Today*,
  *Open Settings*, *Capture page to Today* and *New node in Today* **in both roles
  — as a row title and as an action label**. The last two are worth stating
  precisely because they ship today as *action labels*
  (`spec/launcher.md` → *"Action labels are verbs"* exempts them as the case where
  "the label IS the information"); D6/D8 removes the exemption by splitting each
  into an object row plus a verb, so step 13 must retire that spec sentence in the
  same change or the guard and the spec contradict each other. A query with one
  or more object matches yields no draft; a no-match query yields exactly one draft
  object titled with the entered text, *New node* as its type label, and *Create
  node* as its primary action.
- **AC-04 — Catalog exhaustiveness and node routing (D1a).** A golden fixture contains
  exactly the 19 family ids, accepted subject kinds and surface exposures; `remove`
  is present, while `moveToTrash`, `go`, `navigate`, toggle ids, `run` and `mainList`
  exposure are absent. Reference and field-row cases assert structural actions use
  `row`, content actions use `content`, and activation/pin actions use
  `canonicalSurface`. `remove` fixtures cover ordinary-only, field-value-only and
  mixed selections, asserting the D1a names and the shipped trash-then-field-removal
  step order. A selection does not gain `sendToAgent`; the anchored node
  presentation preserves the shipped one-node handoff.
- **AC-05 — Object-set filtering (D2).** Assert the context menu renders only actions whose
  subject exists in that opening's node/selection object set. In a multi-select
  opening, every selection-capable family appears once with the selection subject,
  while node-only families appear once with the anchored node subject; no flat-map
  duplicates are possible. System-node and app-surface objects cannot leak in unless
  the anchored node is itself that system node. `setViewToolbarVisible` and
  `editViewSection` require view facts tied to that node ref
  (`panelId + visualRowId + rowExpanded`), while `setPinned` requires only
  `workspace.isPinned`; they remain node-subject actions and are absent out of app
  when those attested facts do not exist. A fixture carrying `view` but no
  `workspace` can still build the correct view-section effect.
- **AC-06 — Parameter-object binding and admission (D1a/D5).** `Move to` and *Add
  tag* candidate queries return only `ObjectPresentation`s and install them in the
  main-owned generation for the exact action/subject/parameter slot. Choosing a
  destination node, tag node or tag draft preserves the parent request's subject and
  binds only the correlated argument; candidate objects never become compound
  command rows or replacement subjects. Fixtures accept a current candidate and
  reject: its prior generation, the same ref under another action, subject or
  parameter, and a main-list subject ref substituted by backing identity. A
  resolver-installed Today destination for a fixed page remains valid across a main
  object query, while the Today slot for an invalidated draft is removed with it.
- **AC-07 — Contract correlation (D1a), the reason these types live in PR 1 at all.** A
  compile-time **negative** fixture: wrong args for a command, `bindAs` on a
  non-bindable step, and step refs in **`create_tag.name`** and
  **`create_capture.input.title`** must each **fail** type-checking, while
  `apply_tag.nodeId`, `apply_tag.tagId` and the nested
  `create_capture.input.destinationParentId` paths compile. Runtime coverage:
  `ensure_date_node → navigate(bound focus node)`, user-visible
  `create_tag → apply_tag(bound tagId)`, and
  `ensure_date_node → create_capture(bound destination, bind capture) →
  apply_tag(bound capture, literal or bound tag)`. Each asserts that the value was
  extracted through `ACTION_BINDINGS.produces`, not a special case. Runtime
  `open(Today)` covers `bindingUnresolved`; `open(Main window)` and `open(Settings)`
  execute `activateAppSurface` successfully with the main window initially closed.
  Request fixtures also reject a subject/action mismatch and arguments for the wrong
  action family.
- **AC-08 — Explicit-state convergence (D1a/D2).** A homogeneous selection presents
  only its state-changing Done variant; a mixed selection presents both.
  `setDone(true)` changes only not-done nodes and `setDone(false)` changes only done
  nodes. Re-evaluation after either request reaches the requested homogeneous state;
  no runtime toggle remains in a resolved presentation.
- **AC-09 — Ambient arrival, object activation and draft payload (D4/D6).** A
  launcher opening begins with `ambient.pending`, an empty fixed set and a ready
  empty-query generation. Type before context resolves; the authoritative late chip
  preserves both text and results and becomes active while activity is implicit.
  Repeat after `ArrowDown`/click explicitly selects a result; the chip appears without
  stealing activity. `ArrowUp`/first `Esc`, clearing or superseding the query restores
  an available chip. With no chip, the first current result is active. Removing a
  chip promotes that result without closing the invocation. A
  matching node/system-node/app-surface object uses `open`; only a zero-match query
  produces a node-purpose draft using `create`. The same query remains independent
  `draftText` throughout. A multi-selection has no primary action, so Enter is inert
  until the user chooses from `Actions ⌘K`; its panel contains only
  selection-subject families, and selecting an individual node never invents an
  implicit first-node subject.
- **AC-10 — Capability, generation and lifecycle admission (D1a/D1b).** A real
  launcher sender can call its dedicated query/action API but both
  `lin:invoke('get_projection')` and `lin:invoke('delete_node', …)` are rejected;
  non-launcher senders are rejected by `launcher:*`, while Settings/provider app
  calls remain green. Subject-query tests cover an empty `pending` replacement,
  out-of-order responses, a superseding query, old node/draft replay, chip deletion
  and selection-aggregate replacement. Argument tests cover current, stale and
  cross-slot refs independently of the subject generation. Ambient tests cover slow
  external context, a late sender-checked in-app seed, rejection of a launcher seed
  response or forged ambient tuple, query/context interleaving, replacement of an old
  ambient ref, old-opening/request replay, capture failure to `none`, and resolution
  after execution has claimed the record. Only current refs
  in their correct membership domain are admissible; replay returns `stale` or
  `superseded` without a fabricated presentation. The confirmation
  response sequence remains request → `confirmationRequired` + challenge → dialog →
  challenge-bearing request → execution result, with wrong-sender and forged-seed
  rejection at invocation creation.
- **AC-11 — Confirmation parity (D1 `confirm`).** In PR 1 the assertion is **strict**: the
  shipped `ConfirmDialog` still appears, with the same copy and the same subject
  set, and no effect exists before it resolves — no weakening to "some confirmation
  appeared", which is what would have hidden a swapped dialog. PR 2 replaces it with
  the native sheet for the two irreversible actions and re-verifies focus and
  keyboard behaviour in both themes.
- **AC-12 — Applicability (D7).** Property test: every rendered action either applies, or
  is rendered with its rejection reason. Nothing silently inapplicable.
- **AC-13 — Action result signal (D9).** E2E: fire a mutating action from the panel with
  the main window in the background; assert the user gets a result signal.
- **AC-14 — Capture and handoff (D4/D9).** Keyboard E2E from a background page:
  hold ambient capture unresolved, type a note, then release capture; assert the late
  page chip becomes active without losing text. Press Enter before the 120 ms
  retrieval debounce settles and after the main query has invalidated the initial
  Today **subject** ref; assert capture still succeeds through its distinct current
  Today **argument** ref and reports confirmation. Repeat with an existing tag and a tag draft,
  asserting the complete bound effect plan and resulting user tag. Then type a
  question, choose `Send to Agent` without reselecting the page, and assert
  exactly one staged user draft plus exactly one untrusted page context. A separate
  no-match case explicitly selects its draft and asserts `create(draft, Today)`
  creates a plain node without capture provenance.
- **AC-15 — Full verification.** Light + dark visual verification (UI diff); `typecheck`, `test:core`,
  `test:renderer`, `test:e2e`, `docs:check`. For PR 2 this includes the step-13
  spec and guard edits **in the same PR** (A6): a green suite reached by leaving
  `spec/launcher.md` describing a surface the PR just deleted is not a pass.
- **AC-16 — Composition guard and bar presentation (D6a).** Renderer fixtures: a
  composing keydown (`isComposing` / `key: 'Process'` / `keyCode: 229`) for Enter,
  ArrowUp/Down and Escape fires no action, moves no activity, opens no panel and
  never dismisses — in the main input, the `Actions ⌘K` panel and a parameter
  picker. Presentation: at rest the bar's left zone renders the app mark + the
  formatted summon hotkey and the right cluster renders the active object's verb
  label + `↵` and `Actions ⌘K`; a failed action renders its reason in the status
  zone with the hint cluster intact; the primary label is never the row title.
  Light + dark covered under AC-15's diff.

## Open questions

None open. The directional decisions were settled before approval rather than
deferred: object/action separation and the 19-family catalog, including
row-policy-driven `remove` (D1a/D8); the boundary between a genuine command object,
the no-match draft fallback and today's compound pseudo-commands (D3/D6); bound
references without a `commands.ts` change (D1a); and the `Move to` retrieval path
through main with debounce, request identity, cancellation and an A9 measurement
(D5). The review-driven boundaries are closed too: a dedicated minimal launcher
preload plus main capability gate; separate subject-result and
action/subject/parameter-scoped argument generations; a main-owned late ambient
transition that preserves query/text state and never steals explicit activity; input
as main-owned payload independent of subject selection; nested `create_capture`
bindings plus a native-host app-surface effect; and visual-row facts in `view` while
only pin state remains in `workspace`. Two presentation decisions are also closed:

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

- `archive/launcher-interaction-hardening.md` — **shipped as #497 (2026-08-07)**;
  it was the ONE pre-PR-2 PR on the *shipped* surface (the discoverability plan
  was merged into it 2026-08-06). Landed: the IME guard, the window-level fix for
  the CJK candidate window, dev-only error copy, the D6a bar anatomy, the sidebar
  *Search* row and the Settings hotkey display. **Its interim empty-query Enter
  wait was withdrawn at the review gate, not shipped** — so PR 2 has nothing to
  delete there and owns the show→context race at its source (D6a). PR 2 keeps the
  guard and the CSS, adds `Actions ⌘K`, replaces the hand-wired status zone with
  D9's result state (D6a), and — when it retires the global `Cmd+K` (D3) —
  retargets the sidebar row to the panel summon so its hint re-derives from the
  remaining binding (`Sidebar.tsx:137`, one call site, inside step 12's sweep).
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
- `reference/browser-extension-integration.md` — record-only, and a **deferred second
  extraction source** (JS-rendered / signed-in pages) behind the static reader. Its
  fallback-chain claim and its `PageContentExtractor` nomination were corrected in
  this change. One correction remains outstanding: **the filename says "extension"
  while its own non-goals exclude one**, and renaming breaks the `docs/TASKS.md`
  link, so it needs the main agent.
- `archive/agent-conversation-model.md` / `archive/agent-data-model.md` — historical authorities for the
  handoff content shape in D9.

## Collision self-check

Re-run at the start of each PR — with `gh pr list` + `gh api …/files --paginate`.
(The `--paginate` matters: the default page returns 30 files, which is why an
earlier sweep read #483 as touching only `ThreadView`.)

**As of 2026-08-07 there are no open PRs, so neither implementation PR is
blocked or ordered behind anything.** Every PR the previous snapshot ordered
against has merged: #483 (2026-08-05), #490 (2026-08-05), #488 and #480
(2026-08-06), #497 (2026-08-07). An empty radar is a fact about one moment, not a
standing permission — re-derive before opening each Draft PR.

PR 1 touches `src/core/actions/` (new), moved predicates under
`src/renderer/ui/interactions/`, `NodeContextMenu.tsx`, both locale catalogs and
main-side admission wiring. It touches no agent, composer or launcher file.

PR 2 additionally touches `src/renderer/ui/CommandPalette.tsx` (deleted),
`src/renderer/launcher/*`, `src/main/launcher/*`,
`src/main/context/contextCapture.ts`, `src/core/launcher/sources.ts` (capture-template
factoring only), `src/preload/index.ts`, a new minimal
`src/preload/launcher.ts`, infrastructure-owned `electron.vite.config.ts`, the
composer path and both locale catalogs. **Plus the palette's consumers, which
earlier drafts of this list omitted and step 12 now enumerates:** `App.tsx`,
`Sidebar.tsx`, `NodePanel.tsx`, `outliner/OutlinerItem.tsx`,
`outliner/SlashCommandMenu.tsx`, `useWorkspaceKeyboard.ts`,
`interactions/slashCommands.ts`, `interactions/shortcutRegistry.ts`,
`core/i18n/messages/{en,zh-Hans}.ts`, `styles/overlay-palette.css`,
`styles/popover-command.css`, `tests/e2e/typography-tokens.spec.ts`,
`tests/renderer/sidebarSearchRow.test.tsx`, `tests/renderer/rowInteractions.test.ts`,
and the spec set in step 13. That omission is the reason step 12 is now a derived
table rather than a sentence — and the reason its query is scoped `src tests docs`
rather than one directory: the queue comes from `rg` (A11), not from memory. No currently open PR touches
`electron.vite.config.ts`; the PR 2 Draft claim must name it explicitly and re-run
the ownership/collision check before editing it.

**Neither `src/core/commands.ts` nor `src/core/types.ts` is touched**, and no
interface-first PR is required — settled in D1a rather than left to implementation.
(Three earlier drafts of this section were stale: naming #477 as the only open PR,
then calling #486 open after it merged, then recording only #486 while #483 and
#487 were already open — which is why this check is re-derived from `gh pr list` at
the start of each PR, never from memory.)

## Appendix — provenance

Why this shape rather than another. Kept so the settled boundaries are not
silently re-opened; not needed to build the design above.

### The evidence

The repository already contains the controlled experiment, one line right and one
line wrong:

| Action | Entry points | Shared | Not shared |
|---|---|---|---|
| Apply a tag | 3 (`#` trigger popover — which is `TagSelector`'s only renderer — node context menu, batch selector) | candidate list + ranking (`ui/interactions/tagSelector.ts`) | **apply**: three implementations (`TagSelector.tsx:43-52`, `BatchTagSelector.tsx:89-93`, `NodeContextMenu.tsx:250-258`) |
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

**Borrowed — the feel.** One global hotkey, no modes, one always-focused input for
filter/search with a no-match draft fallback, fuzzy match, Enter runs the active
object, a non-activating panel that never makes you leave what you were doing. This
shipped and this plan preserves it with two D4/D6 clarifications: creation is a
no-match-only result, and an ambient chip becomes/remains active unless the user has
explicitly entered the result list, so slow context does not lose page + typed note
and never steals an explicit choice.

**Borrowed — the row / action-bar split.** Rows are objects with a right-aligned
type label; the primary action lives in the bottom bar with `↵`, and the rest
behind `Actions ⌘K` (D6). Tenon already ships the left half.

**Raycast's `Command` label does not collapse the model.** A row such as *Search
Files* names an independently launchable tool; the action bar separately says *Open
Command*, and the object can own configuration/alias actions. Tenon's current
*Open main window* and *Open Settings* rows lack that independent identity, so they
become app-surface objects. A genuine tool command can join later as another object
provider without putting registry actions in the main list.

**Borrowed — the command surface as *the* entry point.** Lazy's launcher is a
command runner, not a search box. That ambition is what the action registry (D1)
delivers — but populated from **Tenon's own action set**, not Lazy's.

**Not borrowed — Lazy's command families.** The observed table
(`Clip article` / `Clip PDF` / `Clip email` / `Clip DM` / `Read later` /
`Watch later` / `Summarize video` / `Generate tags`, ibid. §"Lazy command families
observed") is **overwhelmingly** *bring the outside in*. The exceptions are a
conversion family (`Turn Note into Capture`, `Turn Capture into Task`, ibid.
422-434) that does operate on the user's own items — real, and small enough that
the shape of the table still holds. So Lazy's window and Tenon's `Cmd+K` were never
two similar things — they share a silhouette, not a job. Merging them therefore needed an
abstraction spanning two non-overlapping jobs, and `Target × Verb` was invented to
fill an intersection that does not exist. Its mistake was making object/action
pairs into top-level rows instead of letting the active object resolve its actions.
That is why the earlier revision of this plan grew a verb matrix, a chip-arity
model, habit learning, and a reversibility tier. **The merge still happens here** —
one hotkey, one surface, `CommandPalette.tsx` deleted — but because the launcher is
already a superset of the palette, not because two similar things were fused.

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
