# Validation And Coverage

A cleanup route is acceptable only when every source record is accounted for.

Coverage statuses:

- `imported`: became an normalized import node or field.
- `merged`: folded into another imported structure, such as a description,
  field, tag, or date heading.
- `dropped`: deliberately removed because it is system/trash/generated noise.
- `unsupported`: recognized but not importable in this release.
- `empty`: no user-visible content after cleanup.

`unaccounted` must be zero. Dropped and unsupported records need warning codes
and counts. Large imports may store the full sourceId-to-status table in a
coverage sidecar file while keeping aggregate counts in the pack.

Validation gates:

1. Source profile: bounded sampling and format confidence.
2. Transform: normalized import plus coverage sidecar.
3. Evidence binding: `check-coverage` requires zero unaccounted records and
   verifies the exact generic ChangeSet fingerprint.
4. Diff: `outline diff` validates schema, bounds, selectors, document
   preconditions, and the ChangeSet hash without mutation.
5. Post-import verification: compare the `outline apply` Operation with the
   reviewed Diff's full affected count and hash, validate the bounded return
   Projections requested by the ChangeSet, then independently `outline show`
   representative created roots and date targets. Existing content below a
   Daily Note is outside created-tree counts.

A materialization exception rolls back the whole import, including newly
created year/week/day scaffolding. A post-import mismatch retains the one
completed Operation. Stop without retrying or manually deleting content;
report the Operation ID, mismatches, and verification reads for inspection or
an authorized guarded `outline revert`.
