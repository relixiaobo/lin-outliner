# Tag merge and split fixes — collisions must not kill, splits must not re-seed

## Problem

A deep audit of the field/supertag subsystems (2026-08-13, follow-up to the
tag-schema-projection review) confirmed two live defects that do **not** dissolve
when the projection plan ships, plus several that do. All were verified with
runnable repros against current core.

**P1 — same-name field collisions kill tag application.** Two tags that each
define a field named `Status` (two definitions, one name — the normal outcome of
building two tags independently) are mutually exclusive with a crash: applying
the second tag to a node that carries the first throws
`CoreError: duplicate field "Status" on owner …` out of
`instantiateTagTemplateDirect` → `ensureFieldEntryWithTemplateDirect` →
`assertOwnerDoesNotHaveFieldName`. The whole `applyTag` command dies. Reachable
from the plain UI with the most ordinary field name there is. Two aggravations:
sync `mutate()` has no rollback and `applyTagNoHistoryDirect` pushes the tag into
`node.tags` *before* instantiating, so the failure is not clean — it leaves the
tag applied with partial fields. And the same assert is reachable from the
checkbox: `applyForwardDoneMappingDirect` (done-state → option-field sync) calls
the same helper, so toggling done on a node whose mapped field name collides
crashes the toggle today — a fourth live repro of the same site.

**P2 — merging two such tags poisons the merged tag permanently.**
`mergeTagTemplateChildrenDirect` dedupes template entries by `fieldDefId` only,
never by name, so merging `#bug` into `#issue` moves bug's `Status` template
entry wholesale into issue's template. The merged tag now *itself* defines two
same-named fields, and every subsequent `applyTag` of it — on any node — throws
per P1. One merge, and the tag is unusable for all future instances.
(`merge_definitions` is agent-tool-reachable via `documentService`; the renderer
does not expose it today.)

**P3 — splitting a tagged node re-stamps creation-moment data.** `splitNode`
runs full `instantiateTagTemplateDirect` on the right half. A `#meeting` whose
template holds a seed child `Agenda` and a `Status` default `Inbox`, with the
instance's Status set to `Doing`: mid-text Enter produces a right half with
`Status: Inbox` (not `Doing`, not empty) plus a freshly conjured `Agenda` child.
A text edit mints creation-moment statements.

These are the same root the projection plan names — copies of definition state
stamped at the wrong moments — but they are crash- and correctness-class *now*,
and the projection plan deliberately does not cover them: P1's throw site and
P2's merge behavior are wrong regardless of storage model, and P3 is about
*seeds*, which stay copy-based under projection by design.

## Recorded findings not fixed here

The same audit confirmed three more; recorded so they are not re-discovered,
deliberately left to their owners:

- **Untag misses copies the past template stamped.**
  `cleanupFieldsFromRemovedTagDirect` derives "what this tag brought" from the
  *current* template, so a field deleted from the template earlier leaves
  orphaned entries behind on untag. Dissolves structurally in
  tag-schema-projection PR 1: valueless entries stop existing and untag stops
  deleting anything (decision D1 there).
- **`entry.templateId` dangles forever** once a template entry is deleted;
  `value_is_default` hiding and `resolveFieldOwnerColor` silently degrade.
  Dissolves in PR 1: `templateId` leaves field entries entirely.
- **Tag renames and cross-owner field-name duplication are unguarded.**
  Field-def renames already fail closed on the dangerous case — per-keystroke,
  `applyNodeTextPatch` runs `assertFieldDefRenameDoesNotDuplicateOwner`, which
  rejects a rename that would duplicate a name on any single owner. What remains
  unguarded is *tag* renames (two active tags can share a name;
  `findTagByName` then picks arbitrarily) and same-named field defs on disjoint
  owners. Tolerated: the per-owner case is already guarded, duplicate names
  become visible-and-manageable under projection decision D3, and a tag-rename
  guard would fire mid-typing. Residual wart: `findTagByName` /
  `findFieldDefByName` should pick deterministically (oldest wins) rather than
  by object-iteration order — left recorded.

## Goal

- Applying a tag never throws because of a field-name collision; the colliding
  field is skipped and everything else lands (A12: degrade on the user path).
- Merging two tags unifies their same-named, same-typed fields into one
  definition, instances relinked; a merged tag is never poisoned.
- Splitting a node keeps its tags but mints no creation-moment data: no seed
  clones, no default values. Auto-init still runs (a split's right half acquires
  its tags at that moment; the ratified tag-schema-projection plan already names
  `splitNode` in its auto-init exception).

## Non-goals

- The storage-model change (fields as projection) — that is
  `tag-schema-projection`, already ratified. These fixes land first and are
  deliberately behavior-level: PR 1 there later deletes P1's throw site (apply
  stops writing entries) and shrinks split's writes to auto-init only, while the
  behaviors pinned here — collision skips, merge unifies, split doesn't re-seed —
  survive as its tests.
- Migration for documents that already contain a poisoned tag (pre-release: wipe
  dev userData).
- Exposing `merge_definitions` in the renderer.
- Validating definition renames.

## Shape

**(b) Two independent complete features, one PR each**, no ordering between
them.

## Design

### Fix 1 — collisions skip, merges unify

**Degrade at the stamp boundary.** `ensureFieldEntryWithTemplateDirect` gets a
collision check instead of the bare assert: when the owner already has a
same-named field entry backed by a *different* definition, it returns `undefined`
without creating anything — the tag applies, the colliding field is simply not
stamped for this node. The check must be the assert's own matching converted
into a query (`normalizeFieldNameKey` semantics, trash filtering) — one matcher,
not a hand-rolled second one that can drift.

The helper has exactly three callers, and skip must be handled at each:

- `instantiateTagTemplateDirect` — ignores the return value; nothing to do.
- `applyForwardDoneMappingDirect` — consumes the returned `entryId`
  unconditionally today (`clearFieldEntryValuesDirect` +
  `selectFieldOptionDirect`); on skip the mapping degrades too (that field's
  done-sync is skipped, the toggle itself succeeds). This is the fourth repro
  fixed, not a new behavior.
- `createFieldDef` — the authoring path; its fail-closed behavior is carried by
  the *outer* per-tagged-node assert the command already runs before the loop,
  not by the helper. Stated so the helper's softening cannot be read as
  softening authoring.

`assertOwnerDoesNotHaveFieldName` keeps throwing where a human is choosing a
name right then (`createFieldDef`, `create_inline_field`,
`reuse_field_definition` paths) — there the error is the feature. This is the
A12 line: fail-closed where data is being authored, degrade where a stored
document is being *used*.

Pre-projection, the skipped field is invisible on that node (nothing renders a
def-less field); post-projection it becomes a visible second slot per decision
D3. Both are acceptable; the second is better, which is the point of the
projection plan.

**Merge unifies by name.** `mergeTagDefinitionsDirect`, before moving template
children: for each source template field whose `definitionNameKey` matches a
target template field backed by a different definition, attempt to merge the
definitions — `mergeFieldDefinitionsDirect` already exists and relinks every
entry in the document, so instance entries follow automatically and the
subsequent template-children pass dedupes on the now-shared `fieldDefId`.

**The unification gate covers all three of that helper's throw conditions**, not
just the obvious one: type mismatch, options-from-supertag source mismatch, and
`assertFieldDefinitionValuesCompatible` — document-wide value validation that
can fail even on same-type pairs, because `setFieldConfig` retypes a field
without revalidating stored values (two `date` defs can hold plain-era free
text). A blind call would let one dirty value anywhere kill the whole tag merge —
recreating the one-operation-permanent-damage class this plan exists to remove.
Unification is therefore attempt-per-name-pair with fallback to keep-both,
gated by a non-throwing compatibility predicate extracted from
`mergeFieldDefinitionsDirect`'s checks (all of which run before any mutation,
so the fallback is transaction-safe by construction).

Where a pair is incompatible, the definitions stay separate, both template
entries survive on the merged tag, and Fix 1's skip guard keeps `applyTag`
alive — two same-named fields on one tag becomes a renderable wart instead of a
poison pill, and projection D3 later renders it honestly.

Unification compares **direct template children only**; collisions arriving
through an extends chain are not unified (merging tags does not edit third
tags), and the skip guard covers that residue at apply time — `getExtendsChain`
is specific-first, so the specific tag's field wins the stamp.

**Merged template defaults: the target's win.** The template-children dedupe
path moves the source entry's value children into the target's template entry,
so after unification `#issue` default `Inbox` + `#bug` default `New` would stamp
*both* on every future instantiation. Instead, when the target's template entry
for the now-shared definition already holds default values, the source template
entry's defaults are dropped with the entry. (Instance-entry value merging in
`mergeFieldDefinitionsDirect` is untouched — there the values are user data and
appending is correct.)

### Fix 2 — split stops re-stamping

`splitNode`'s same-parent branch replaces its `instantiateTagTemplateDirect`
call with a field-structure-only variant: each template field goes through
`ensureFieldEntryWithTemplateDirect` with `cloneDefaults: false` — which
preserves auto-init via the existing empty-entry path
(`applyAutoInitializeDirect`) — and the `getTemplateContentNodes` clone loop
does not run at all. Rationale: a split is a text edit; the right half is a
continuation of an existing thing, not a new instance. Seeds and static
defaults are creation-moment statements ("a new X starts with…") and a split
creates no new X. Auto-init is the one deliberate exception, consistent with
the projection plan's freeze-at-acquisition rule.

`applyChildTagsDirect` (the other non-apply acquisition site) is unchanged: a
newly created child *is* a new instance; full instantiation there is correct.

## Sequencing and collisions

Both fixes touch `src/core/core.ts` only (plus tests). Open PRs #533 and #534
touch the same file in unrelated regions (save pipeline; table field columns) —
textual rebase risk only. The tag-schema-projection implementation branch
rebases on top of these; its PR 1 inherits their tests as pinned behavior.

## Checklist

**PR A — collision skip + merge unification**

- [ ] `ensureFieldEntryWithTemplateDirect`: same-name/different-def → skip
      (`undefined`), via a query converted from the assert's own matcher;
      authoring paths keep the assert (via `createFieldDef`'s outer per-node
      check)
- [ ] `applyForwardDoneMappingDirect` handles skip: the mapping degrades, the
      done toggle succeeds
- [ ] Non-throwing compatibility predicate extracted from
      `mergeFieldDefinitionsDirect` (type, options source, values-compatible);
      `mergeTagDefinitionsDirect` unifies per name-pair, falls back to keep-both
- [ ] Template-defaults rule on dedupe: target's defaults win; source template
      entry's defaults are dropped, instance values still merge
- [ ] Core tests (from the audit repros): two tags with same-named fields apply
      cleanly to one node, second field skipped; done toggle on a collided
      mapped field degrades instead of crashing; merging unifies the definition
      and relinks instance entries; merging with an incompatible pair (type
      mismatch AND values-incompatible same-type pair) keeps both and the merged
      tag still applies; merged template stamps only the target's defaults;
      same-name collision across an extends chain applies with the
      specific-first winner; re-apply stays idempotent
- [ ] `docs/spec/commands.md`: apply_tag collision semantics; merge_definitions
      name-unification rule (first-time spec coverage for merge_definitions)

**PR B — split re-stamp removal**

- [ ] `splitNode`: field structure + auto-init only; no default cloning; no seed
      content cloning
- [ ] Core tests: split right half has empty template fields (no default
      values), no seed clones; auto-init date field still fills on the right
      half; cross-parent split (`applyChildTagsDirect` path) still fully
      instantiates
- [ ] `docs/spec/commands.md`: split_node acquisition semantics (tags carry
      over; nothing creation-moment is re-stamped; auto-init freezes)
