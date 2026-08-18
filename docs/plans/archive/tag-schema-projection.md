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

The template is read at exactly two sites: `instantiateTagTemplateDirect` from
`applyTagNoHistoryDirect`, and from `splitNode` (mid-row Enter re-instantiates
the template on the right half for the tags it inherits). Nothing re-reads it, so
the template is a one-shot stamp, not a definition.

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
- Static default values render as inherited placeholders and never write
  themselves into a node.
- Freeform template children stay seeds, copied once at tag time, with an
  explicit idempotent action to hand them to older nodes.

## Non-goals

- **Projecting freeform content children.** Field rows are unordered and
  non-destructive, so projection is clean. Freeform children get reordered,
  indented, deleted and interleaved with the user's own content — projecting them
  means "this instance deleted its projected child" needs a tombstone, which
  re-dirties exactly what this plan cleans. Content stays a seed.
- **Deleting stored values.** A value the user typed is user data. It survives the
  field leaving the tag, and (D1) the tag leaving the node.
- **Migration.** Pre-release: on format change we wipe `~/.lin-outliner-*` and
  delete the old reader.
- **Continuous template→instance reconciliation** of any kind. See Alternatives.

## Shape

**(b) A set of independent complete features**, three PRs, ordered by dependency.
Each is shippable and verifiable alone:

1. **Field projection.** Fixes rows 1 and 2 of the table above — a field added to
   a tag reaches every node already carrying it. Row 3 (defaults) is PR 2's.
2. **Static defaults as ghost values.** Depends on 1.
3. **Seed backfill action.** Independent of 1 and 2; works on the current model
   too.

PR 1 is the large one. Its real chunks are: the accessor and its cache, the
storage-rule command, virtual-row identity in the renderer, the search
operators, and the 23-file reader sweep. None of them can ship without the
others, which is why this is one PR and not four (A7).

## Design

### 1. Field projection

**One accessor.** `nodeFieldSlots(state, nodeId)` returns the ordered slots for a
node:

```
{ fieldDefId, source: 'tag' | 'own', sourceTagId?, templateEntryId?, entryId? }
```

`entryId` is present only when a value is stored. `sourceTagId` and
`templateEntryId` carry provenance that consumers need today and the shape would
otherwise drop: `resolveFieldOwnerColor` (`OutlinerFieldRow`) resolves a field
row's tag color through `entry.templateId` as its first-priority lookup, and both
`value_is_default` (`outlinerRows`) and PR 2's ghosts have to read the template
entry's values. `templateId` on the stored entry therefore goes away — the slot
carries what it was for — while it stays on seed content clones, where dedup
still needs it.

**Order.** Tag slots come first — above the node's own fields (D4), which matches
where `insertFieldEntryNodeDirect(nodeId, 0, …)` puts them today — in template
order per tag, ancestor-first across the extends chain. The template order part
is *not* what happens today: `getExtendsChain` returns self-first and each entry
is inserted at index 0, so groups land ancestor-first but the fields *within* one
tag end up reversed relative to the template. No test pins multi-field order
(every existing test is single-field), so the projection quietly fixes that
quirk. It is a change, not a parity claim.

**Storage rule.** A `fieldEntry` node exists only once it holds a value.
`apply_tag` writes no field entries — with one exception, below.

**The auto-init exception.** Slots whose field has `autoInitialize` configured
must still be materialized where a node acquires a tag — `apply_tag`, `splitNode`
inheriting tags, and `applyChildTagsDirect` — because every strategy in
`autoInitStrategiesForFieldType` (`current_date`, `ancestor_day_node`,
`ancestor_field_value`, `ancestor_supertag_ref`) resolves against the moment and
the tree position at which the tag was acquired. Those values have to be frozen
right then: a `current_date` left virtual would re-resolve to *today* on every
read, so a node tagged in January would silently start claiming August, and an
`ancestor_*` value would change the moment someone moved the node. So those paths
keep calling `applyAutoInitializeDirect` for auto-init slots and write nothing
for the rest. This is a genuinely write-once statement and it is not retroactive:
a field given auto-init afterwards leaves already-tagged nodes empty, which is
the correct answer rather than a limitation.

**Materialization is a core command, not a renderer behavior.** Find-or-create
already exists in three places — the table's `beginFieldEdit`, the agent edit
path (`create_inline_field` followed by `reuse_field_definition`, two mutations),
and `applyPasteMetadataDirect`. Materialize/dematerialize is a storage-rule
invariant, so it becomes one core command (find-or-create-then-set;
remove-when-empty) that renderer, agent and paste all call. Otherwise an agent
clearing a value through `clearFieldValue` leaves an empty tag-slot entry behind
and the document drifts straight back into being a pile of copies.

**Dematerialize on commit, not per keystroke.** Deleting the last character must
not delete the row under the cursor; the entry is removed when the edit commits
(blur / navigation away) and the slot goes back to virtual. This applies to
`source: 'tag'` slots only — an emptied `source: 'own'` entry is kept, because the
node is the only record that the field exists there at all.

**Dedupe.** Concurrent first-edits of the same virtual slot on two devices can
merge into two entries for one `fieldDefId`. `nodeFieldSlots` resolves this: first
entry in child order wins, the rest are treated as own fields. (The same race
exists today at concurrent `apply_tag`, so this is not a regression — it just now
has a stated rule.)

**Virtual-row identity in the renderer.** A slot with no `entryId` must still be
a real row: focusable, selectable, keyboard-navigable and editable **without a
node id**. `buildChildRows` keys rows by child id, and the synthetic rows that
exist today (`hidden:`, `filtered:`) are non-editable, so this is new ground. It
needs an explicit id scheme — `slot:<nodeId>:<fieldDefId>` — threaded through
`selectableRows`, focus/UI state (`focusTarget` takes a node id today),
pending-input targeting, context menus and batch operations, plus a stated list
of what a virtual row *cannot* do (no drag, no indent/outdent, no delete, no
tags, no children) so the parity matrix's row behaviors stay honest. This is the
single biggest chunk of PR 1.

**Search must become slot-aware inside PR 1.** The engine already implements
`FIELD_IS_SET`, `FIELD_IS_NOT_SET`, `FIELD_IS_DEFINED`, `FIELD_IS_NOT_DEFINED`
and `IS_EMPTY`, all routed through `comparableFieldState`, whose `hasField` means
"an entry exists". Today `apply_tag` guarantees tagged nodes have entries, so
those operators work. The moment valueless slots stop having entries, all five go
false unless `comparableFieldState`, `fieldReads` and `fieldDateRanges` read
slots. This is a correctness dependency, not an improvement. The three states get
pinned explicitly:

- **defined** — the slot exists (from the tag chain or an own entry)
- **set** — a value is stored
- **empty** — the slot exists and no value is stored

**Name collisions become constructible, and both rows show.**
`assertOwnerDoesNotHaveFieldName` fires today *because* `apply_tag` writes
entries; once it doesn't, "node already has its own `Status`, then gets a tag
defining a different `Status`" is reachable in ordinary use, and clicking that
slot would materialize through `create_inline_field`, whose identical assert
throws — a rendered row that can never be edited. Resolution (D3): the two
definitions stay two slots and render as two rows, and the materialize path does
not run the name assert. Merging them silently would repoint a user's field at
someone else's definition; a duplicate name on screen is the honest outcome and
the user can rename either side. The assert still guards user-initiated field
creation, where the name is being chosen right then and a duplicate is a mistake
worth catching.

**Cache.** Slots depend on other nodes (tag defs, template entries, the extends
chain), so they cannot live in `patchProjectionCache`, which caches strictly
per-node `projectNode(node)` results and invalidates by affected node id — a
template edit would never invalidate its instances, and the write fan-out this
design removes would come back as a cache-invalidation fan-out. Slots get their
own derived layer: memoized per `(nodeId, schemaEpoch)`, where the epoch bumps on
any mutation inside Schema or a tagDef subtree, recomputed lazily. Cheap, but it
is a design, not an assumption.

**Agent read parity.** `agentNodeToolProjection` renders a node's fields to the
agent from entries; under projection it must render slots, or the agent will keep
"creating missing fields" that already exist. Empty slots render in a compact
form — ten empty rows per node would eat prompt budget for nothing.

**What this deletes.** No fan-out writes on template edits, so: no O(instances)
writes per keystroke inside a template, no single undo step that rewrites
hundreds of nodes, and no two-devices-mint-two-clones-of-one-rule problem — the
class of failure any reconciler must handle and this design cannot express.

### 2. Static defaults as ghost values

Two kinds of default exist and only one can be a ghost:

- **Static default** — a literal value typed into the tag's field slot
  (`Status: Inbox`). Context-free, so it reads the same on every instance at
  every moment. This one becomes a ghost.
- **Auto-init** — `current_date` and the `ancestor_*` strategies. Resolved
  against a moment and a tree position, so it is written once when the tag is
  acquired and left alone. Never a ghost.

A static default stays where it is today, on the tag's field slot. An
unmaterialized slot renders it as a placeholder, visually marked as inherited
using the neutral `--text-*` ladder (B3/B4: no accent, no status color). It
materializes when the user edits the slot or explicitly accepts it, and from that
moment it is theirs and never tracks the template again.

Retroactive by construction: a default added to a tag today is visible on every
instance that has not set a value, with zero writes and no risk of overwriting
anything anyone typed. The question "did the user mean to leave this empty?" —
which any write-based back-fill has to guess — never comes up.

### 3. Seed backfill action

`apply_template_to_tagged_nodes(tagId)`: adds the template's content children to
nodes already carrying the tag, deduped by `templateId` (the existing mechanism
in `cloneTemplateContentNodeShallowDirect`), as one undoable step, reporting the
count first ("adds 2 children to 37 nodes"). Explicit user intent, no heuristics,
no background mirroring.

## Alternatives considered

**Reuse the existing back-fill from the UI path.** `createFieldDef` already loops
`findNodesWithTag` and calls `ensureFieldEntryWithTemplateDirect`; wiring the
tag-side `create_inline_field` into the same loop is roughly fifty lines and
ships today. Rejected as the destination, worth knowing as a stopgap: it fixes
*add* only — rename, remove, retype and reorder each need their own fan-out — and
every one of those fan-outs entrenches the copy model this plan is trying to
leave. If the PM wants the bug closed this week and the architecture next month,
this is the shape of the stopgap.

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
the initialization does not (it is a write). Their "initialization" is our
`autoInitialize`, and this plan draws the same line in the same place. Where it
goes further is splitting out the *static* default, which Tana leaves on the
write side along with everything else; a static default is context-free, so it
can be a ghost, and a ghost costs nothing to make retroactive.

## Decisions (PM-ratified 2026-08-13)

- **D1 — Untagging keeps typed values.** `remove_tag` stops deleting the tag's
  field entries (`cleanupFieldsFromRemovedTagDirect` and the core test "tag
  template instantiates fields and removal cleans them up" both change). Entries
  holding values survive as `source: 'own'` fields; valueless slots simply stop
  being projected, because they were never nodes. Taking a tag off a node can no
  longer lose data.
- **D2 — Ghost defaults answer queries.** A node displaying `Inbox` is found by
  `Status = Inbox`, in search and in table sort/filter alike
  (`comparableFieldState`, `fieldReads`, `fieldDateRanges`, `fieldValuesForNode`
  all read the ghost). Ghosts stay invisible to writes. Accepted cost
  (PM-ratified 2026-08-13, at the gate): on a field that has a static default,
  `is empty` matches nothing — ever. Clearing a stored value dematerializes the
  entry and the ghost returns, so there is no per-node way to blank a defaulted
  field; the empty state is reached by storing a real value or removing the
  default from the tag. "Empty" means what the user sees, not what is stored,
  and the storage rule keeps zero exceptions (ratified over an explicit-empty
  tombstone entry, which would reintroduce valueless entries for exactly one
  case).
- **D3 — Same-name collisions render as two rows.** Two definitions stay two
  slots; the materialize path drops the name assert. The rejected alternative —
  merging into the node's existing same-named field — would silently repoint a
  user's field at the tag's definition.
- **D4 — Tag fields sit above the node's own fields**, in schema order, and are
  reordered on the tag (which reorders them on every instance at once). Own
  fields keep per-node drag.

## Open question

**Does D4 remove per-node drag for tag fields, or only set their default
position?** Building against the first reading: tag slots are not individually
draggable on an instance. The second reading needs a per-node order-override
stored on the node, which is another schema-shaped fact living in a copy — the
kind of thing this plan exists to remove — so it wants to be a deliberate choice.
Nothing else in PR 1 depends on the answer; it can land before the virtual-row
chunk.

## Checklist

**PR 1 — field projection**

- [ ] `nodeFieldSlots` accessor with `sourceTagId` / `templateEntryId` provenance
      and the first-entry-wins dedupe rule
- [ ] Derived slot cache keyed `(nodeId, schemaEpoch)`; epoch bumped by Schema /
      tagDef-subtree mutations
- [ ] One core materialize/dematerialize command; renderer, agent and paste all
      call it; dematerialize on commit, `source: 'own'` entries exempt
- [ ] `apply_tag` / `splitNode` / `applyChildTagsDirect` write auto-init slots only
- [ ] Virtual-row identity: `slot:<nodeId>:<fieldDefId>` through `buildChildRows`,
      `selectableRows`, focus/UI state, pending input, context menu, batch ops;
      documented list of what a virtual row cannot do
- [ ] Search: `comparableFieldState`, `fieldReads`, `fieldDateRanges` slot-aware;
      defined / set / empty pinned per operator
- [ ] D1: `cleanupFieldsFromRemovedTagDirect` keeps valued entries as own fields;
      its core test is rewritten to pin the new behavior
- [ ] D3: materialize path drops the name assert; user-initiated creation keeps it
- [ ] `templateId` dropped from field entries (kept for seed clones);
      `resolveFieldOwnerColor` and `value_is_default` read slot provenance
- [ ] Agent projection renders slots compactly
- [ ] Reader sweep is rg-driven (A11): `rg "=== 'fieldEntry'"` over `src/` is the
      work queue, not a hand-kept list; done when the remaining hits are only the
      accessor and stored-entry type guards that never enumerate a node's field
      list (backlink classification in `references`, codec/write paths, the
      `systemFields` DONE check)
- [ ] Core tests: field added to a tag appears on nodes tagged before it; auto-init
      freezes at tag acquisition while other slots write nothing; field removed
      from a tag vanishes where valueless and survives as an own field where a
      value exists; clearing a tag slot dematerializes on commit while an own
      field survives; extends-chain order; the five search operators against
      virtual slots
- [ ] Renderer tests: first keystroke in a virtual slot is not lost; a virtual row
      is selectable and keyboard-reachable

**PR 2 — ghost defaults**

- [ ] Placeholder rendering for unmaterialized slots (light + dark, `--text-*`),
      static defaults only — a slot with auto-init never renders a ghost
- [ ] Materialize on edit / explicit accept
- [ ] Search, table sort and table filter read ghosts per D2
- [ ] Tests: default added after tagging shows everywhere; a typed value is never
      replaced; accepting a ghost writes exactly once

**PR 3 — seed backfill**

- [ ] `apply_template_to_tagged_nodes` command + confirmation with count
- [ ] Tests: idempotent by `templateId`; single undo step; skips trashed nodes

**Docs**

- [ ] `docs/spec/commands.md` knowledge-model section: fields are projected, values
      are stored, defaults are inherited until materialized, auto-init is frozen
      at tag acquisition
- [ ] `docs/spec/ui-behavior.md`: virtual slot rows and ghost-value rendering
- [ ] `docs/spec/search-query-grammar.md`: defined / set / empty against slots

## Sequencing

PR 1 lands after #533 (typing hot-path, `core.ts` + `loroDocument.ts`) and #534
(table field column semantics). #534 is a **semantic** overlap, not just a
textual one: it adds `addMissingTableDisplayFieldsDirect`, which scans
`type === 'fieldEntry'` children to decide which columns to create, so "fields
used by these records" changes meaning under projection and that scan has to
become slot-aware. #534 also rewrites `OutlinerTableView`, `outlinerRows`,
`userViewContext`, `document.ts` and `selectableRows` — the exact files PR 1 must
route through the accessor. After #534 merges, re-verify the reader sweep and the
table sections against the merged code before starting.
