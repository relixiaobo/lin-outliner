# Validation And Coverage

A cleanup route is acceptable only when every source record is accounted for.

Coverage statuses:

- `imported`: became an Import Pack node or field.
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
2. Transform: Import Pack plus coverage sidecar.
3. Preview: `tenon-import preview` validates schema, bounds, destination, pack
   hash, and coverage through the app import API before returning a preview id.
4. Post-import verification: `tenon-import commit` asks the app import service
   to read back only the exact roots created by the operation and compare
   section/node/preserved structure counts. Existing content below a Daily Note
   is outside those counts.

A materialization exception rolls back the whole import, including newly
created year/week/day scaffolding. A post-import count mismatch instead retains
the one completed operation and returns `staged_with_errors` or
`imported_daily_with_errors` with its created roots, operation ID, and
mismatches. Stop without retrying or manually deleting content; report those
values for inspection or a guarded exact undo.
