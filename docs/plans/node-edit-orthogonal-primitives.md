# node_edit → orthogonal primitives

## Goal

Make delete-by-omission **unrepresentable** in the node mutation surface. Reduce
that surface to four orthogonal, id-addressed primitives — **create, edit-one,
move, delete** — so that no tool ever takes "the desired complete subtree" as an
argument, and therefore no edit can trash a node the agent never saw. Clean
because each tool does exactly one thing; safe by construction, not by guard.

## Non-goals

- **Not** adding gates / sentinels / read-completeness tracking / any "make the
  declarative overwrite safe" machinery. We delete the declarative overwrite, so
  none of it is needed.
- **Not** changing the `src/core` command protocol — these tools already route
  every mutation through `host.handle(...)`; `commands.ts`/`types.ts` are
  untouched.
- **No** migration / back-compat (pre-release). The `node_edit` outline-reconcile
  is removed outright; wipe dev `userData` if a serialized detail shifts.
- **Not** redesigning fields as a feature — only making field edits obey the same
  no-omission-delete rule.

## Background — remove the reconcile action, don't patch it

The data-loss class came from one capability: `node_edit` with `old_string: "*"`
(or any multi-node fragment) reconciles a **desired full subtree** against the
live tree and trashes every existing child absent from the desired text
(`agentNodeTools.ts:1485-1488`; engine `:1226-1497`). Preview never modeled the
deletion (`:480-487`); reads truncate at ≤50 children (`agentNodeToolRead.ts:39`)
while the reconcile acts on ≤500 (`agentNodeTools.ts:407`). A lossy view drove a
lossless overwrite whose blast radius was the complement of what the agent saw.

The deeper fact — surfaced once we noticed **`node_create` already authors whole
new subtrees from an outline** (`agentNodeToolSchemas.ts:108`; `duplicate_id`
`:122`) — is that the reconcile action is **redundant**. Everything it does
decomposes into operations we already have, each of which names its target by id
and so *cannot* delete by omission:

- new node / subtree → `node_create(outline, parent_id, after_id)`
- a node's own content → a single-node edit (below)
- reorder / reparent existing nodes → move (already `node_edit action:move`,
  batched via `node_ids`, `:1099`)
- remove nodes → `node_delete(node_ids)` — commission (`:262`)

So the reconcile action is the *only* carrier of delete-by-omission **and** the
*only* redundant primitive. Removing it eliminates the bug and shrinks the
surface at once — mostly subtraction, with one small named addition (a name-keyed
field-upsert helper; see Design).

## Design

### The four orthogonal primitives

| Axis | Tool | Rule |
|---|---|---|
| **create** | `node_create` | Author new node(s)/subtree from an outline at a position. Every node is new — nothing to reconcile, nothing deletable. *(Exists.)* |
| **edit one** | `node_edit` | Edit **one existing node's own** content — text, description, checkbox, tags, fields — by id, in place. Never accepts a multi-node outline; never touches child structure. |
| **move** | `node_move` | Reorder / reparent existing node(s) by id (batchable). Cannot create or delete. *(Today a `node_edit` action; promote — OQ1.)* |
| **delete** | `node_delete` | Trash node(s) by id. The single deletion verb. *(Exists.)* |

No tool accepts a "this is the complete desired state of a container" argument.
Deletion is therefore always an explicit, by-id act — **make illegal states
unrepresentable**, the strongest form of the safety property: not prevented by an
invariant someone must keep true, but impossible to express.

### `node_edit`, restricted to one node

`node_edit(node_id, …)` edits one node and returns; it has no concept of
children. It may set:

- **text** — full replacement, or an `old_string`/`new_string` surgical edit
  **scoped to that node's own text** (exactly Claude Code's Edit on a one-line
  "file": targeted, uniqueness-checked, never delete-by-omission).
- **description, checkbox, tags.**
- **fields** — **upsert-by-name**: setting field "Due" creates-or-updates *Due*
  and replaces *Due*'s value(s); it never touches a field you did not name.
  Replacing a *named* field's value(s) is commission (you named it); omitting a
  *different* field never prunes it. Remove a field/value via `node_delete` by id.

This is mostly subtraction, with one small, named addition for the field path:

**Removed** — the `"*"` whole-outline mode, the multi-node fragment reconcile, and
the child / full-list reconcile behind them: `applyOutlineRootToExistingNode`, the
children path of `syncOutlineNodeInPlace`, `syncNormalChildren`, the *positional,
prune-by-omission* `syncFieldEntries` (`:1299-1353`), and the `"*"` branch of
`replaceOutline`.

**Retained & reused** — `syncFieldValues` (`:1355`), `createField`, and
`sequenceEditPlan` survive untouched: setting a *named* field's values is
commission, so the value-setting machinery is exactly what upsert needs.

**Added (the lone non-subtraction)** — a small **name-keyed** `upsertField(s)`
helper: for each named field, find-by-name → `syncFieldValues` if it exists, else
`createField`; never trash an unnamed field. It replaces `syncFieldEntries`'
positional, prune-by-omission matching with name-keyed upsert. Naming it here so
the "subtraction" framing stays honest — this is the one piece of new code.

`merge_from_node_ids` and `replace_with_reference_to` stay as explicit by-id
actions (merge trashes only the named `mergeFromNodeIds`, `:626`) — not part of
the footgun (placement per the Decisions below).

### The one invariant, applied recursively

**No operation deletes by omission, at any scope.** Children, fields, and field
values are all nodes; none is ever pruned for being left out of a desired list.
Every deletion is `node_delete`-by-id (or an explicitly named clear). That is the
*entire* safety model — there is nothing else to enforce, because there is no
declarative-overwrite path left to guard.

### What composes to the old conveniences

- "Reorganize this board" → a few `node_move`s + `node_edit`s + `node_delete`s,
  each by id: granular, reviewable, individually undoable — and exactly what the
  incident agent did *correctly* before it reached for `"*"`.
- "Replace node X's contents with a fresh subtree" → `node_delete` old children +
  `node_create` new. Two explicit steps; no hidden deletion.
- "Type out a new structure" → `node_create(outline)` — the outline-authoring
  ergonomic is preserved exactly where it is safe (creation).

### Why this beats every gated alternative (and Claude Code)

Gating the declarative overwrite (read-completeness + CAS, like Claude Code's
Write) makes the dangerous primitive *safe*; removing it makes the danger
*non-existent* and deletes all the guard machinery with it. We can go further
than Claude Code because a node subtree has stable ids and structural ops where a
file has neither — CC keeps Write only because file lines are not addressable.
With ids, `create` + `delete` compose to "replace contents", so we need no
Write-equivalent at all. The surface then maps 1:1 to the A4 command model and to
filesystem `create / edit / mv / rm`.

## Consumer surface (audited)

A repo audit confirms the change lands cleanly:

- **Engine removal is self-contained.** The reconcile helpers
  (`applyOutlineRootToExistingNode`, `syncNormalChildren`, `syncFieldEntries`,
  `syncFieldValues`, `sequenceEditPlan`, `replaceOutline`) have **no callers
  outside `agentNodeTools.ts`** — deleting them touches nothing else in `src`.
- **The only skill consumer already lives by the new rules.** `memory-dream`
  (`builtInSkills/memory-dream/SKILL.md`) uses `node_edit` for "small, direct
  edits … in place", `node_create` for new nodes, `node_delete` for removal — it
  never teaches `*` or subtree reconcile. Migration = a wording pass at most.
- **Teaching surface is small and localized:** `agentNodeToolGuidance.ts:19,98,99`
  (unmarked-line-creates / child-structure-edit / `*`) and
  `agentNodeToolSchemas.ts:182` (the `old_string` description) — plus spec docs
  (A6).
- **Test rewrite is a contained subset.** In `tests/core/agentNodeTools.test.ts`
  (1800 lines), the reconcile / `*` / child-structure cases are ~5–7 (598, 799,
  822, 884, parts of 647/715/766); the `node_create` / `node_delete` / move /
  merge / reference / `node_read` / `node_search` cases survive with minor
  adaptation.

## Decisions

- **Tool boundary.** Keep `move`, `merge_from_node_ids`, and
  `replace_with_reference_to` as `node_edit` actions in this PR — they are already
  by-id and non-destructive (merge trashes only the named sources, `:626`), so the
  safety goal does not need them promoted. Splitting them into one-tool-per-axis
  (e.g. a dedicated `node_move`) is a **documented, optional, cosmetic follow-up**,
  deliberately out of this PR to keep the safety change small and reviewable.
- **`node_edit` text form.** Support both a full `text` replacement and an
  `old_string`/`new_string` surgical edit **scoped to the one node** (cheap,
  mirrors CC's Edit on a small file).
- **Field / field-value removal.** Remove via `node_delete` by id; no separate
  `clear` verb. Keeps the surface minimal and every deletion explicit.

## Shape & build order

**Shape (a): one complete feature in one PR** — the safe orthogonal surface.
Internal order:

1. Restrict the `node_edit` **outline-edit action** to a single node in place
   (drop `"*"` and the multi-node fragment reconcile). Add the name-keyed
   `upsertField(s)` helper for fields (reusing `syncFieldValues` / `createField`).
   Keep the `move` / `merge_from_node_ids` / `replace_with_reference_to` actions
   unchanged. Update the schema (`agentNodeToolSchemas.ts:182`) and description.
2. Confirm `node_create` / move / `node_delete` cover every reshape need; turn
   the removed path into a redirecting error ("node_edit no longer edits subtrees
   — use node_create, node_edit action:move, or node_delete").
3. Delete the child / full-list reconcile — `applyOutlineRootToExistingNode`,
   `syncNormalChildren`, the children path of `syncOutlineNodeInPlace`, positional
   `syncFieldEntries`, the `"*"` branch of `replaceOutline` — while **retaining**
   `syncFieldValues` / `createField` / `sequenceEditPlan` for the upsert path.
4. Update the teaching surface from the audit — `agentNodeToolGuidance.ts:19,98,99`
   and the `memory-dream` wording if needed.
5. Spec sync: `docs/spec/agent-tool-design.md` (the four-primitive surface);
   rewrite the ~5–7 reconcile / `"*"` guard tests in
   `tests/core/agentNodeTools.test.ts` (A6, same change).
