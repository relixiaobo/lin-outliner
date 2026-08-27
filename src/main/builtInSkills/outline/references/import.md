# Import External Data

Use this workflow for external notes, structured exports, migrations, and
cleanup-before-import requests. Import uses the public `outline` CLI and ends in
one generic ChangeSet, one reviewed Diff, one Operation, and one exact revert.
There is no source-specific Runtime API.

## Inspect the Source

Start with a bounded profile instead of loading a large export record by record
into model context:

```sh
outline --json import inspect SOURCE
```

The profile reports source kind, confidence, bounded statistics, samples, and
warnings without starting Runtime or writing document state. Resolve material
choices such as destination, date handling, fidelity, and intentional cleanup
before planning the import.

## Choose an Adapter Path

If the source already matches `outline schema NormalizedImport`, pass it to
`import plan --format normalized`. For a format supported by a bundled adapter,
such as Tana JSON, use that format directly. `--format auto` selects only a
deterministically recognized normalized or bundled format; it never guesses a
mapping for unknown data.

For any other format, write or reuse a task-local cleanup adapter that:

- reads only the authorized source files;
- emits exactly `NormalizedImport` plus complete source-record coverage;
- performs no Tenon reads or writes and never invokes `outline` mutations;
- keeps source-specific concepts out of the ChangeSet and Runtime;
- records unsupported or deliberately dropped records instead of inventing a
  mapping.

Bundled scripts are optional adapters, not private document authorities. An
Agent-authored adapter follows the same boundary and its normalized output uses
the same public import path.

## Coverage Contract

Every source record is accounted as `imported`, `merged`, `dropped`,
`unsupported`, or `empty`; `coverage.unaccounted` must be zero. Dropped and
unsupported records carry warning codes and counts. Zero unaccounted records
proves accounting completeness, not fidelity, so review unsupported and dropped
counts against the requested fidelity policy.

Normalized import supports typed trees with titles, descriptions, tags,
checkbox state, code, fields, and children. `native_daily` ensures exact
`YYYY-MM-DD` dates and creates their trees in the same ChangeSet. `stage` places
the import under one `Import: <source>` root. Import is append-only; it does not
silently synchronize or deduplicate existing content.

## Plan and Review

Create the immutable Diff and evidence through one public invocation:

```sh
outline --json import plan SOURCE \
  --output import.diff.json \
  --evidence-output import.evidence.json
```

Common explicit forms are:

```sh
outline --json import plan tana-export.json --format tana --fidelity full \
  --output import.diff.json --evidence-output import.evidence.json

outline --json import plan cleaned.json --format normalized \
  --output import.diff.json --evidence-output import.evidence.json
```

Review the source and ChangeSet fingerprints, Diff hash, affected count,
coverage, warnings, date set, destination, bindings, returned Projections, and
destructive classification. Stop on unresolved coverage, ambiguous selectors,
unsupported structures that require a product decision, or an artifact
fingerprint mismatch.

## Apply and Verify

If the original request authorizes the import and the review passes, apply the
exact artifact once:

```sh
outline --json apply --input import.diff.json > operation.json
outline --json import verify OPERATION_ID \
  --diff import.diff.json --evidence import.evidence.json
```

`import verify` binds the Operation to the reviewed Diff and evidence, checks
affected counts and returned bindings, and performs bounded independent reads
of representative roots and dates. Report the Operation ID, affected count,
date range, coverage, warnings, and verification result.

Never retry an apply whose settlement is uncertain. Inspect `outline log`
instead. If verification fails after a completed Operation, preserve the state
for inspection and use only an authorized guarded revert:

```sh
outline --json revert OPERATION_ID
```

## Tana Mapping

The bundled Tana adapter reconstructs `docs[]` ownership, skips system and
Trash subtrees by default, decodes ordinary text, preserves descriptions,
checkboxes and code blocks, maps deterministic tag and field tuples, and records
every skipped record in coverage. It recognizes a Daily Note only from an exact
valid local `YYYY-MM-DD` journal date; ambiguous headings remain ordinary
content with a warning.

Tana view/search definitions, associated data, locked metadata, and other
structures without a deterministic user-meaningful mapping remain explicit
unsupported coverage. `--fidelity full` means every mapping implemented by the
adapter, not byte-for-byte or complete Tana semantic fidelity.
