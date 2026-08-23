# Normalized Source

Normalized import v1 is the boundary between source adapters and Tenon's import.
Adapters may emit this read-only intermediate shape. The helper validates it,
accounts for coverage, and converts it to a generic `outline.changeset`; Runtime
never receives or recognizes this source-specific structure.

Required top-level fields:

- `version: 1`
- `source`: `{ kind, path, sourceId? }`
- `options`: fidelity/date/tag/field/done-state choices
- `stats`: computed aggregate counts
- `coverage`: source-record accounting
- `warnings`: structured warnings
- `sections`: importable outline sections

Each `ImportNode` may contain:

- `title`
- `description`
- `tags`
- `checked`
- `code`
- `fields`
- `children`
- `sourceId`

Within one node, tags must be unique after trimming and case folding. Fields
must be unique after Tenon's canonical field-name normalization; represent
multiple values in one field entry's `values` array rather than repeating the
field.

Adapters should keep source-specific concepts out of the write path. Convert
them to user-meaningful Tenon content, warnings, or dropped/unsupported coverage
entries.

Destination modes:

- `stage` writes every section below one `Import: <source>` root at the selected
  destination.
- `native_daily` appends each date section directly below Tenon's canonical day
  node and writes all non-date sections below one staging root. It never
  overwrites, deduplicates, or synchronizes existing Daily Note content.

A native date section has `kind: "date"`, a `date` field containing an actual
local calendar date in exact `YYYY-MM-DD` form, and a matching title. Adapters
must not infer native dates from ambiguous headings. The generated evidence
binds the source fingerprint, selected mode, and exact generic ChangeSet; the
reviewed Runtime Diff then binds that ChangeSet to the current document state.
