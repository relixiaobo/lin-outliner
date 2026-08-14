# Tag merge and split fixes - definition identity and split acquisition

## Goal

- Make tag application and tag merge follow Tana's field identity model:
  `fieldDefId`, not the display name, decides whether two fields are the same.
  Same-name fields backed by different definitions coexist.
- Make name-based field writes deterministic when Schema contains duplicate
  labels: direct owner entries take precedence, then the owner's applied tag
  inheritance chains provide a specific-first definition choice.
- Make same-parent node splits retain tag-driven field structure without
  re-stamping defaults or seed content. Acquisition-time auto-initialization
  still runs.

## Non-goals

- Automatically merging field definitions because their display names match.
- Silently choosing between multiple same-name field entries already visible on
  one owner.
- Adding an originating-tag suffix or other visual disambiguator to duplicate
  field labels. Tana presents identical labels, and v1 follows that behavior.
- Changing the field storage model; that belongs to `tag-schema-projection`.
- Migrating pre-release data or exposing `merge_definitions` in the renderer.

## Problem

Tag template stamping currently treats a field label as an owner-level unique
key. Applying two independently authored tags that each define `Status`
therefore throws from `ensureFieldEntryWithTemplateDirect`. The tag is written
before template instantiation, so the failed command can also leave a partial
result. Forward done-state mapping reaches the same throw site.

The first attempted repair skipped the second field at runtime and unified
compatible same-name definitions during tag merge. That is not Tana's model and
creates a document-wide side effect: merging two tags can delete a shared field
definition and rewrite a third tag that the user never selected.

Tana's documented contract resolves both defects:

- A field's primary instance carries one definition object. Selecting an
  existing field reuses that definition and its settings.
- Generic node merge combines children, and combines values only when both
  nodes contain the same field.

Therefore, "same field" means the same definition identity. A label is only
presentation. Two independently created `Status` fields remain two fields
after their supertags merge.

Sources:

- [Fields](https://outliner.tana.inc/learn/features/fields)
- [Supertags](https://outliner.tana.inc/learn/features/supertags)
- [Merging duplicate nodes](https://outliner.tana.inc/learn/features/nodes-and-references#merging-duplicate-nodes)

A separate split defect remains: `splitNode` runs full template
instantiation on the right half. A text edit can therefore recreate static
defaults and seed children that describe a newly created instance.

## Shape

**(b) Two independent complete features, one PR each.** Definition-identity
semantics and split acquisition touch nearby Core surfaces but have no behavior
or merge-order dependency.

## Design

### Feature A - field definition identity

#### Tag application and done mapping

`ensureFieldEntryWithTemplateDirect` is keyed only by `fieldDefId`. It reuses
an existing entry for that exact definition and otherwise creates a new entry,
even when another entry on the owner has the same normalized display name.
`instantiateTagTemplateDirect` continues to walk the specific-first extends
chain, so it materializes every unique definition in that chain. Reapplying a
tag remains idempotent because the identity check still deduplicates the same
definition.

`applyForwardDoneMappingDirect` already carries the mapped `fieldDefId`.
It creates or updates that exact entry and never needs a name-collision skip or
runtime diagnostic.

Explicit authoring remains fail-closed. `createFieldDef`,
`createInlineFieldAfterNode`, `reuseFieldDefinition`, and field rename still
reject a second same-name field on the owner. Runtime composition of two tags is
a legitimate state; explicitly authoring a duplicate on one owner is still
treated as a likely mistake.

#### Tag merge

`mergeTagDefinitionsDirect` follows generic node-merge identity semantics:

- A source template entry whose `fieldDefId` is absent from the target moves
  to the target unchanged, regardless of its label or field type.
- When source and target template entries share the same `fieldDefId`, all
  source value children append to the surviving target entry. Existing
  instances whose `templateId` names the removed source entry are rewritten to
  the target entry before the source is deleted.
- Source tag references are rewritten to the target tag, then the source tag is
  removed.

Tag merge never merges field definitions by name and never relinks uses on an
unselected third tag. Explicitly merging two field-definition ids remains
document-wide because the user named those identities directly. Its
compatibility validation may index active entries once per command to avoid
repeated full-document scans without changing the contract.

#### Name-based field resolution

The resolver keeps owner entries as the first authority:

- One direct owner entry with the requested normalized label wins.
- More than one direct owner entry is ambiguous. The write refuses and returns
  the entry ids, instructing the caller to address the intended entry by id or
  rename one field.

When the owner has no matching entry and Schema has multiple active definitions
with that label, resolution uses the owner's applied tags. For every applied
tag, walk its extends chain specific-first. Compare all chains by inheritance
depth: the first depth containing matching template definitions wins if it has
exactly one unique `fieldDefId`. Reuse of the same definition by several tags
still counts as one candidate. No reachable candidate, or multiple candidates
at the winning depth, preserves the existing
`duplicate_field_definitions` error.

`FieldResolutionNode` therefore includes `tags`. Core projections already
carry them. Agent create preflight gives each prospective owner the ids of its
resolved tags so permission analysis selects the same definition as execution.
Unknown tags contribute no existing definition.

#### Rendering and view identity

Duplicate labels stay visually identical. Identity-sensitive renderer and view
paths remain keyed by `fieldDefId` or entry id:

- `buildOutlinerRows` emits one row per field entry.
- `value_is_default` resolves through each entry's own `templateId`.
- Table default columns and View Toolbar field choices retain separate
  definitions even when their labels match.

No source-tag badge or label suffix is added.

### Feature B - split without re-stamping

The same-parent branch of `splitNode` replaces full tag-template
instantiation with field-structure acquisition. Each inherited template field
goes through `ensureFieldEntryWithTemplateDirect` with
`cloneDefaults: false`; the template-content clone loop does not run.

The empty-entry path still invokes `applyAutoInitializeDirect`. This is
intentional: a split's right half acquires its tags at that moment, while static
defaults and seed content are statements about creating a new instance.

Cross-parent split remains unchanged. Moving into a parent with
`childSupertag` is real tag acquisition and still applies defaults and seed
content. `applyChildTagsDirect` keeps full instantiation for the same reason.

## Implementation Surface

Feature A:

- `src/core/core.ts`
- `src/core/fieldResolution.ts`
- `src/main/agent/capabilities/agentNodeTools.ts`
- focused Core, field-resolution, agent-tool, and renderer tests
- `docs/spec/commands.md`, `docs/spec/ui-behavior.md`, and removal of the
  obsolete collision diagnostic from `docs/spec/error-observability.md`

Feature B:

- `src/core/core.ts`
- focused Core tests
- `docs/spec/commands.md`

`FieldResolutionNode.tags` is a shared internal surface, so all consumers and
tests change in Feature A rather than as an unrelated follow-up. The two
features edit disjoint symbols and test groups within their shared files.

## Risks

- Multiple applied tags can expose genuinely ambiguous same-name entries.
  Name-based writes must refuse rather than pick by traversal order.
- Extends chains can contain cycles or inactive tags. Resolution uses a visited
  set and stops at the first invalid link.
- Collapsing same-definition template entries must rewrite every live
  `templateId` before deletion or `value_is_default` silently degrades.
- View and row collections must never deduplicate by display label.
- Split acquisition must preserve auto-init while excluding both static field
  defaults and non-field seed nodes.

## Verification

### Feature A

- [ ] Applying two tags with independently defined same-name fields creates both
      entries and remains idempotent.
- [ ] Done mapping updates its exact definition when a same-name field coexists.
- [ ] Tag merge preserves same-name/different-definition template entries and
      does not rewrite a third tag sharing one source definition.
- [ ] Tag merge combines all values and rewrites template origins only for the
      same definition.
- [ ] Explicit field-definition merge remains compatible and document-wide.
- [ ] Field resolution covers a specific tag over its ancestor, same-depth
      ambiguity, no reachable candidate, one definition reused by multiple tags,
      and owner-entry ambiguity.
- [ ] Outliner rows, `value_is_default`, Table defaults, and view choices keep
      duplicate labels as separate identities.

### Feature B

- [ ] Same-parent split retains tags and empty field structure without static
      defaults or seed content.
- [ ] Acquisition-time auto-init still materializes on the right half.
- [ ] Cross-parent child-supertag acquisition still applies full defaults and
      seed content.
