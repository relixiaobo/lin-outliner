# Tag schema projection — fields are defined, not copied

## Problem

Set a template on a tag and the nodes already carrying that tag never learn about
it. Add a field to `#project` today and every existing project node keeps the
shape it happened to have on the day it was tagged.

Verified against the current core (four scenarios; three fail):

| After the tag is already applied | Result |
|---|---|
| Add a field via the UI path (`create_inline_field` on the tag) | ❌ instances unchanged |
| Add a content child to the template | ❌ instances unchanged |
| Give a template field a default value | ❌ instances unchanged |
| `create_field_def(tagId, …)` | ✅ back-fills — but no renderer code calls it; `documentService` exposes it to agent tools only |

`applyTagNoHistoryDirect` → `instantiateTagTemplateDirect` is the only path that
reads a template (plus the copy-node path in `copyNodeSubtree`). Nothing re-reads
it, so the template is a one-shot stamp, not a definition.

### Root cause

The template block mixes two statements of different kinds, and the code
materializes both the same way — as copies, at one instant:

- **A rule.** "A project *has* a Status field." True for every instance at every
  moment.
- **A seed.** "A new project *starts with* a Notes child, Status = Inbox." True
  only at creation; afterwards that content belongs to the user.

Copying a rule is what breaks: N copies of a rule are not a rule, they are N
independent historical snapshots. Every "sync the copies back up" design is then
forced to invent a second concept — which copies still count as obedient — and
that concept is invisible to the user. The fix is not better syncing. It is to
stop copying the rules.

## Goal

**The tag defines; the node stores only what the user actually put there.**

- A node's field list — presence, order, type — is derived from its tag chain at
  read time. Adding, removing, renaming, retyping, or reordering a field on a tag
  is instantly true for every instance, past and future, with zero writes.
- A node stores field *values* only.
- Default values render as inherited placeholders and never write themselves into
  a node.
- Freeform template children stay seeds, copied once at tag time, with an
  explicit idempotent action to hand them to older nodes.

## Non-goals

- **Projecting freeform content children.** Field rows are unordered and
  non-destructive, so projection is clean. Freeform children get reordered,
  indented, deleted and interleaved with the user's own content — projecting them
  means "this instance deleted its projected child" needs a tombstone, which
  re-dirties exactly what this plan cleans. Content stays a seed.
- **Deleting stored values.** A value the user typed is user data. It survives the
  field leaving the tag, and (proposed, see Open questions) the tag leaving the
  node.
- **Migration.** Pre-release: on format change we wipe `~/.lin-outliner-*` and
  delete the old reader.
- **Continuous template→instance reconciliation** of any kind. See Alternatives.

## Shape

**(b) A set of independent complete features**, three PRs, ordered by dependency.
Each is shippable and verifiable alone:

1. **Field projection.** Fixes the reported bug by itself.
2. **Inherited defaults as ghost values.** Depends on 1.
3. **Seed backfill action.** Independent of 1 and 2; works on the current model
   too.

## Design

### 1. Field projection

**One accessor.** `nodeFieldSlots(state, nodeId)` returns the ordered slots for a
node:

```
{ fieldDefId, source: 'tag' | 'own', entryId?: NodeId }
```

Order: tag chain ancestor-first (the order `instantiateTagTemplateDirect`
produces today), then the node's own ad-hoc entries. `entryId` is present only
when a value is stored. Every current reader of `type === 'fieldEntry'` off
`children` goes through this instead — 23 files today, the load-bearing ones
being `outlinerRows`, `OutlinerItem` / `OutlinerFieldRow`, `OutlinerTableView`,
`searchEngine`, `fieldResolution`, `references`, `agentNodeToolProjection`,
`agentNodeTools`, `userView`, `selectionActions`, and the action-registry facets
(`rowFacets`, `candidates`, `objects`).

**Storage rule.** A `fieldEntry` node exists only once it holds a value.
`apply_tag` writes no field entries at all.

**Materialize on write.** The first keystroke or option pick in a virtual slot
creates the entry. This pattern is already shipped: `OutlinerTableView`'s
absent-cell path calls `create_inline_field` with an existing `targetDefId` and
buffers the typed character through a pending-materialization map so it is not
lost across the async command. That local implementation moves into the shared
row layer and the table stops being a special case.

**Dematerialize on clear.** Clearing the last value of a `source: 'tag'` slot
removes the entry, returning the slot to virtual — otherwise every
touched-then-cleared field leaves an empty node behind and the document drifts
back into being a pile of copies. `source: 'own'` entries are kept when emptied:
the node is the only record that the field exists there.

**Removing a field from a tag** makes the slot vanish everywhere. Nodes holding a
value keep their entry, which is now `source: 'own'`. "Never delete user data"
stops being a policy someone has to remember and becomes what the mechanism does.

**`hideField` is unaffected** in meaning: `always` / `hidden` / `empty` /
`not_empty` apply to slots exactly as they apply to entries today.
`value_is_default` gets simpler — it compares against the schema default instead
of chasing the `templateId` back-pointer.

**`templateId` on field entries disappears.** It exists only to remember which
template a copy came from; with a schema there is nothing to remember. It stays
on seed content clones (used for dedup — see 3).

**Search semantics improve.** Field predicates see slots, so a `#project` with no
Status still *has* Status. `has field` = the slot exists; `field is empty` = no
stored value. Today those two are indistinguishable, because "no entry" and
"empty entry" are both just absence-of-text.

**Cost and caching.** Rows no longer read field entries straight off `children`;
each row resolves its slots through the tag chain. That result is per (node,
tag-chain revision) and belongs in the existing projection cache that
`patchProjectionCache` maintains, not recomputed per render.

**What this deletes.** No fan-out writes on template edits, so: no O(instances)
writes per keystroke inside a template, no single undo step that rewrites
hundreds of nodes, and no two-devices-mint-two-clones-of-one-rule problem — the
class of failure that any reconciler has to handle and this design cannot
express.

### 2. Inherited defaults as ghost values

The default stays where it is today, on the tag's field slot. An unmaterialized
slot renders it as a placeholder, visually marked as inherited using the neutral
`--text-*` ladder (B3/B4: no accent, no status color). It materializes into a
real value when the user edits the slot or explicitly accepts it, and from that
moment it is theirs and never tracks the template again.

Retroactive by construction: a default added to a tag today is visible on every
instance that has not set a value, with zero writes and no risk of overwriting
anything anyone typed. The question "did the user mean to leave this empty?" —
which any write-based back-fill has to guess at — never comes up.

### 3. Seed backfill action

`apply_template_to_tagged_nodes(tagId)`: adds the template's content children to
nodes already carrying the tag, deduped by `templateId` (the existing mechanism
in `cloneTemplateContentNodeShallowDirect`), as one undoable step, reporting the
count first ("adds 2 children to 37 nodes"). Explicit user intent, no heuristics,
no background mirroring.

## Alternatives considered

**Continuous reconcile with "an unedited copy follows its template."** Rejected.
It invents a third state — a copy that looks like the user's but is secretly
still linked to the template — that the user cannot see. A stray keystroke
silently severs the link; an edit that coincidentally matches silently keeps it.
An invisible state machine with a heuristic transition is where "why did my node
change?" reports come from. It also puts an O(instances) write fan-out on the
keystroke path inside a template definition.

**Exact Tana parity.** Tana lands in the same place from the same pressure:
fields are live, seeds are one-shot. Their Fields doc: *"Initialization is only
triggered when a node gets the supertag applied to it. If the supertag gets
updated with a field with initialization switched on, and the supertag was
already applied to nodes, these nodes will only see the field added without any
content initialized in it."* — the field appears retroactively (it is schema),
the default does not (it is a write). This plan matches that on fields and goes
one better on defaults, because a ghost value is not a write and therefore costs
nothing to make retroactive.

## Open questions

1. **Untag semantics.** `remove_tag` deletes the tag's field entries today
   (`cleanupFieldsFromRemovedTagDirect`). Under projection, only entries holding
   values exist — deleting them is deleting typed data. Proposed: untagging keeps
   them as `source: 'own'` fields. This is a visible behavior change and wants a
   PM call.
2. **Do ghost defaults answer queries?** Proposed yes for reads (`Status = Inbox`
   should match a node that displays Inbox) and never for writes. The cost is
   that `Status is empty` becomes subtle on a field that has a default.
3. **Name collision between a tag slot and an own field.** Same `fieldDefId`
   merges into the one slot. Same *name*, different definition: proposed that both
   render, since silently hiding one is worse than showing a duplicate name — but
   `assertOwnerDoesNotHaveFieldName` currently forbids the situation, so this only
   decides what happens to documents that already contain it.

## Checklist

**PR 1 — field projection**

- [ ] `nodeFieldSlots` accessor + projection-cache integration
- [ ] `apply_tag` stops writing field entries; materialize-on-write and
      dematerialize-on-clear in the shared row layer
- [ ] All 23 `type === 'fieldEntry'` readers routed through the accessor;
      `OutlinerTableView`'s local absent-cell path folded into the shared one
- [ ] `templateId` dropped from field entries (kept for seed clones)
- [ ] Search: slot-aware `has field` vs `field is empty`
- [ ] Core tests: field added to a tag appears on nodes tagged before it; field
      removed from a tag vanishes from valueless nodes and survives as an own
      field where a value exists; clearing a tag slot's value dematerializes it
      while an own field survives; extends-chain order preserved
- [ ] Renderer tests: first keystroke in a virtual slot is not lost

**PR 2 — ghost defaults**

- [ ] Placeholder rendering for unmaterialized slots (light + dark, `--text-*`)
- [ ] Materialize on edit / explicit accept
- [ ] Search participation per Open question 2
- [ ] Tests: default added after tagging shows everywhere; a typed value is never
      replaced; accepting a ghost writes exactly once

**PR 3 — seed backfill**

- [ ] `apply_template_to_tagged_nodes` command + confirmation with count
- [ ] Tests: idempotent by `templateId`; single undo step; skips trashed nodes

**Docs**

- [ ] `docs/spec/commands.md` knowledge-model section: fields are projected, values
      are stored, defaults are inherited until materialized
- [ ] `docs/spec/ui-behavior.md`: virtual slot and ghost-value rendering
