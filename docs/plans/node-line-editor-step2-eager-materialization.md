---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-05-26
updated: 2026-05-26
builds-on: node-line-editor-step1-extraction.md
---

> **Codex review incorporated (2026-05-26).** Option A (client-*proposed* id,
> core validates and owns; single id factory; `key === nodeId`) is confirmed as
> the right direction. Seven P1s are accepted and fold into the plan below — the
> central reframe is that **the hard problem is lifecycle, not id**: first input,
> IME, async projection arrival, view transforms, and undo cleanup must be
> designed as **one state machine**. Specifically:
>
> 1. **Materialize on first *committed* content, not `compositionstart`.** During
>    IME composition no text is committed (`RichTextEditor` only flushes at
>    `compositionend`), so materializing on `compositionstart` would leave an
>    empty node if the composition is cancelled. The editor instance is stable
>    regardless of *when* we materialize (the key never changes), so we wait for
>    real content — no empty-node window. A node that is later emptied + blurred
>    is deleted (delete-on-empty cleanup).
> 2. **Materialize creates the node carrying the current buffer text; the patch
>    that *triggered* it must be a no-op** (the node did not exist when that
>    patch fired) to avoid a double first character. Text typed during the async
>    create window is reconciled once the node arrives (a small in-flight
>    reconciliation — much less than step 1's full commit dance, but not zero).
> 3. **Stable key is necessary but not sufficient — the keyed element must be the
>    *same component type* for draft and materialized.** A `<DraftRow>` →
>    `<OutlinerItem>` swap remounts even with the same key. Step C must make the
>    keyed element a single `EditableOutlinerRow` that branches on props.
> 4. **`buildOutlinerRows` stays pure projection.** It also feeds
>    `flattenVisibleRows` (keyboard nav/selection) and agent view context, so a
>    renderer-only draft must NOT be injected there. The draft row is appended in
>    the render layer (`RowHost`/`OutlinerView`) at the position the materialized
>    node will occupy, so identity is preserved without polluting nav/selection.
> 5. **Renderer-only draft fixes *pre*-materialize pollution but not view
>    transforms.** Once real, the node enters `filterRows`/`groupRows` and may
>    vanish/jump in filtered/grouped/sorted views. Rule: pin the focused
>    just-materialized row while editing, or keep lazy commit in transformed
>    views.
> 6. **Strict core validation (done in A.1):** the proposed id must match
>    `node:<uuid>`; an existing id is idempotent only for a same-parent retry,
>    never a focus-existing-node backdoor; anything else throws.
> 7. **Dedicated materialize undo path**, not an extension of the text-edit
>    group: a `materialize_draft_node` metadata/path so the create + following
>    text patches share one `operationId`/undo group.
>
> Adopted sequencing (replaces the one at the bottom): (1) shared
> `freshNodeId()` + validator + optional id, renderer-internal only; (2)
> materialize undo-group API/metadata + core & DocumentService tests; (3) append
> draft rows in the render layer without changing `buildOutlinerRows`; (4) single
> keyed `EditableOutlinerRow`, then remove the lazy commit dance last.

> **Implemented (2026-05-26), pending app verification.** Built on branch
> `cc/node-line-editor-core-impl`:
>
> - **A (core/main).** `freshNodeId()`/`isClientNodeId()` extracted to
>   `src/core/nodeId.ts` (single source for renderer + core). A `create_node`
>   carrying `materialize: true` opens a text-edit undo group keyed to the new
>   node (`DocumentService.beginMaterializeGroup`), so the create + the patches
>   that follow undo as one step. `api.materializeDraftNode(...)`. Headless tests
>   for the id shape and the create+patch single-undo.
> - **B/C (renderer).** The key realization: `OutlinerItem` already edits over a
>   local buffer and emits granular patches, so the draft is just an
>   `OutlinerItem` with a **synthetic empty node** (`makeDraftNode`) — the editor
>   sits at the same JSX position before/after materialization, so it is never
>   remounted (satisfies P1.3 at the JSX level without a separate component). The
>   first `onPatch` calls `materializeDraftNode`; in-flight keystrokes reconcile
>   from the buffer on arrival; focus transitions trailing→row via
>   `selectFocusState` (no re-focus, caret undisturbed). The draft row is appended
>   in the render layer (`OutlinerView` `trailingDraft` mode: `always` body /
>   `auto` child); `buildOutlinerRows` stays pure. `useTrailingDraftId` mints the
>   id and regenerates it on materialize.
>
> **Scope of this pass / deferred:** the unification covers the **main outliner**
> (panel body + children). `FieldValueOutliner` keeps its `TrailingInput` (its
> options-picker / typed-control surface is out of scope). **Depth-shift on an
> empty trailing line (Tab/Shift-Tab before typing) is a no-op for now** — after
> the row materializes on first input, Tab indents normally. `TrailingInput.tsx`
> is no longer used by the main outliner but is retained for the field-value
> surface. IME continuity + the materialize lifecycle require running the app.

# Eager Materialization — the Tana-model trailing row (step 2)

> **Goal.** Typing any character into the empty trailing line — including the
> first letter of a CJK IME composition — instantly turns that line into a real
> node and shows a fresh empty line below it, with **zero interruption** to
> typing or IME. This replaces step 1's lazy commit (buffer → create on
> Enter/blur) and deletes the entire commit/projection-settle dance, which is
> the root of the trailing-row's timing fragility (e.g. the duplicate-commit
> regression).

## Why lazy commit is inherently fragile, and eager is not

Step 1 unified the *editor* (one `RichTextEditor` for inline + trailing) but
kept **lazy commit**: the text lives in a local buffer and the node is created
only on Enter/blur. That create is async and is followed by a focus handoff and
a buffer reset — a boundary that produces timing bugs and makes "materialize on
the first IME letter" impossible (it would require handing an in-flight
composition from the buffer editor to the new node's editor, which breaks IME).

Eager materialization removes the boundary: the node becomes real the instant
there is content, **in the same editor instance**, so there is never a handoff.

| | when materialized | editor | result |
|---|---|---|---|
| pre-step-1 | lazy (Enter/blur) | two | drift + commit dance |
| step 1 (now) | lazy | one | no drift, still commit dance → dup-commit bug |
| **step 2 (this)** | **eager (first input)** | one (no remount) | no dance, IME-seamless |

> **R1 validated (2026-05-26).** `tests/renderer/eagerMaterializeSpike.test.tsx`
> proves the central assumption headlessly: a row whose React `key` is stable
> across a draft→materialized transition reuses the same component instance —
> and with the **real** `RichTextEditor`, the `.ProseMirror` DOM element is the
> same object before and after the content change, so the ProseMirror
> `EditorView` (created in a mount-only effect) is never torn down. A control
> case confirms that a *changing* id (the current lazy path) remounts. Actual
> IME composition continuity still needs app verification, but the editor
> instance + its DOM demonstrably persist, which is the foundation that makes it
> work.

## The one hard mechanic: stable identity across materialization

React reuses a component instance only when it is the **same type at the same
position with the same `key`**. Rows are keyed by `row.id` (`RowHost.tsx:27`).
So the draft row must already hold the **id it will be persisted under**, and
that id must not change when it materializes.

Our core generates ids itself (`core.ts:2384` `freshId` → `crypto.randomUUID()`)
and exposes no client-supplied id (`client.ts:43` `createNode(parentId, index,
text)`; `documentService.ts:207`). The capability exists internally
(`core.ts:1846` `createPlainNode` → `loro.createNodeWithId(id, …)`); it is just
not threaded through the protocol.

**Therefore the draft row carries a client-generated id from birth, and the
materialize call persists the node under that same id** → the row's `key` is
unchanged → React keeps the same editor mounted → IME is never interrupted.

## Required changes

### A. Core / protocol (coordinated — `commands.ts`, `types.ts`, `client.ts`)

1. **Client-supplied id on create.** Add an optional `id` to the `create_node`
   command args, threaded `client.ts → documentService → core.createNode →
   createPlainNode → loro.createNodeWithId`. When omitted, behaviour is
   unchanged (`freshId`). The id format stays `node:<uuid>`; the renderer
   generates `node:${crypto.randomUUID()}` for drafts.
   - Validation: core must reject a duplicate/exuding id (ignore-or-error) so a
     stale draft can't clobber an existing node.
2. **Undo grouping for materialize.** The materialize `create_node` and the
   text patches that immediately follow on that same node must form **one** undo
   step, so undoing a half-typed new node removes the whole node (no "你"
   orphan). Extend the existing `textEditGroup` mechanism
   (`documentService.ts:39-202`): a `create_node` carrying a `materialize` meta
   flag *opens* a text-edit group keyed to the new node id instead of flushing,
   so subsequent `apply_node_text_patch` on that node join it; the group flushes
   on the usual 700 ms idle / node change.

> These are the coordinated protocol/main-process files. This plan must be
> reviewed by the main agent (and is a candidate to split into its own isolated
> core PR that the renderer work rebases onto).

### B. Renderer — draft row in the model

3. **Draft row.** A panel/parent that currently shows a trailing input instead
   contributes a **renderer-only draft row** to `buildOutlinerRows`:
   `{ id: draftClientId, type: 'content', draft: true }`. It is *not* in the
   core projection, so it is invisible to projection / agent / search / journal
   until it materializes — no empty phantom. The `draftClientId` lives in UI
   state (one per eligible parent) and is regenerated after each materialization.

### C. Renderer — unified node-line row (subsumes `TrailingInput`)

4. **One row-editor component** renders both content rows and the draft row, so
   their identity is stable across materialization. On the draft row it edits
   local `RichText`; on the **first** `beforeinput` / `compositionstart` it calls
   `createNode(parentId, index, currentText, { id: draftClientId, materialize:
   true })`. Because the persisted node reuses `draftClientId`, the row's `key`
   is unchanged → no remount → the composition continues in place. A new draft
   row (new client id) is appended below.
   - All the step-1 wrapper logic that was *commit-dance* (eager buffer,
     `committedVisualText`, projection-settle, post-commit focus suppression,
     duplicate-commit guards) is **deleted** — there is no deferred commit.
   - Depth-shift / effective-parent, the options-field popover, and the
     `#`/`@`/`/` trigger application stay, but now operate on a node that becomes
     real on first input (trigger application can target the real id directly
     instead of the bespoke atomic create-and-apply commands — a simplification
     to evaluate, not required for step 2).

## Materialize flow (happy path, CJK)

1. Draft row shown, `key = node:abc` (client id), no core node.
2. User types first pinyin letter → `compositionstart` → row materializes:
   `create_node(parent, index, "", { id: "node:abc", materialize: true })`.
3. Projection now has `node:abc` (empty, but a real node the user is creating);
   `buildOutlinerRows` emits it at the same position with the same id →
   `RowHost` reuses the same component → editor stays mounted → IME composition
   continues uninterrupted.
4. Composition ends → normal `apply_node_text_patch` updates `node:abc` (joins
   the materialize undo group).
5. The view appends a fresh draft row `node:def` below.

## Risk assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | React still remounts on materialize (identity not actually preserved) → IME breaks | Med | High | Prove the same-key/same-component reuse with a focused harness before wiring the rest; the row-editor must be byte-for-byte the same element for draft and real |
| R2 | Undo leaves a half-typed orphan node | Med | Med | The materialize-grouping in (A.2); test undo right after typing one letter |
| R3 | Empty draft accidentally persisted (phantom) | Low | Med | Draft is renderer-only; materialize fires only on real input, never on focus/click-away |
| R4 | Materialized half-typed node visible to projection/search/agent mid-type | Low | Low | Acceptable — it is a real node with the user's content; same as editing any node |
| R5 | Row-model filter/sort/group relocates the just-materialized row | Med | Med | Materialized node appends at the draft's position (end of children); keep it focused; verify under active sort/filter |
| R6 | Client/core id collision or stale-draft clobber | Low | High | Core rejects create with an existing id (A.1 validation); regenerate draft id per materialization |
| R7 | Large refactor of row rendering (OutlinerItem / RowHost) regresses inline editing | Med | High | Extract a shared row-editor used by both rather than special-casing OutlinerItem; lean on existing inline e2e |

## Verification

- Dev agent: `bun run typecheck`, `bun test`, plus a focused headless test that
  the row component instance is preserved across a draft→materialized id
  transition (R1) and an undo-after-one-letter test (R2).
- Main agent (app): the step-1 manual list **plus** — type one CJK letter into
  the empty line (node appears, composition uninterrupted, new line below);
  undo immediately removes the whole node; click into empty line then click away
  (no node created); materialize under an active sort/filter/group.

## Sequencing

1. **Core PR (coordinated):** client-supplied id + materialize undo grouping,
   behaviour-preserving when unused. Reviewed/merged by the main agent.
2. **Renderer PR:** draft row + unified row-editor + eager materialize; deletes
   step 1's commit dance. Rebases on the core PR.

Until step 2 lands, **step 1 (lazy commit) remains the shipping behaviour** — it
is correct after the duplicate-commit fix; step 2 is the elegance upgrade, not a
bug fix blocker.

## Constraints

Built by the `lin-outliner-cc` dev agent. The core/protocol change (A) is in
coordinated files — flag it for the main agent before/at PR time. No merge / no
push to `main` / no `docs/TASKS.md` edits. IME and the materialize seam need app
verification (the dev agent cannot run the app).
