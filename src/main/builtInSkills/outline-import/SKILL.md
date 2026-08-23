---
name: outline-import
description: Inspect, optionally clean, normalize, preview, and import external notes or data into Tenon through generic outline ChangeSets. Use for Tana, Roam, Obsidian, OPML, CSV/JSON, folders, already-normalized records, migrations, and cleanup-before-import requests.
allowed-tools: file_read, file_glob, file_grep, bash, request_user_input
execution: isolated
---

# Outline Import

Import is a source workflow over the public `outline` CLI. Helper scripts may
inspect, normalize, map, account for coverage, and verify artifacts; they cannot
mutate the document. The only write is one exact Diff applied by `outline`.

## Workflow

1. Resolve the source and run:

   ```sh
   outline import-helper inspect SOURCE --out profile.json
   ```

   Read the bounded profile rather than loading a large export into model
   context. Infer fidelity, destination, date handling, and optional cleanup
   from the request. Ask only when a material choice remains unresolved.
2. If the source already matches the normalized shape in
   [references/normalized-source.md](references/normalized-source.md), skip
   cleanup and use the `normalized` route. For Tana, use the deterministic
   `tana` route. Unsupported source kinds are inspection-only until a
   deterministic adapter accounts for their records.
3. Generate one generic ChangeSet and evidence file:

   ```sh
   outline import-helper tana SOURCE \
     --out changeset.json --evidence-out evidence.json \
     --coverage-out coverage.json --fidelity clean
   ```

   Add `--mode stage` only when the user wants a staging tree. Native Tana
   journal dates default to `native_daily`; every unique date is ensured and
   populated inside the same ChangeSet.
4. Inspect evidence. Every source record must be mapped, intentionally skipped,
   merged, empty, or blocked; `coverage.unaccounted` must be zero. Review
   warnings and any dropped or unsupported records according to the requested
   fidelity. Then bind evidence to the exact ChangeSet:

   ```sh
   outline import-helper check-coverage evidence.json \
     --changeset changeset.json
   ```
5. Produce exactly one Runtime Diff and preserve it as an artifact:

   ```sh
   outline --json diff --input changeset.json --output diff.json
   ```

   Confirm the normalized ChangeSet, ChangeSet hash, Diff hash, affected count,
   warnings, date set, and destructive classification match the reviewed
   evidence. Stop on unresolved selectors, coverage, or fingerprint mismatch.
6. If the original request authorizes import and the review passes, apply the
   exact Diff once without a second confirmation:

   ```sh
   outline --json apply --input diff.json > operation.json
   ```

   Never retry an apply whose settlement is uncertain.
7. Validate settlement, then independently inspect representative roots and
   dates with `outline show` or `outline find`:

   ```sh
   outline import-helper verify-result operation.json \
     --evidence evidence.json --diff diff.json
   ```

   Report the Operation ID, affected count, date range, coverage, warnings, and
   verification reads. If verification fails after a committed Operation, stop;
   preserve the content for inspection and use only `outline revert
   OPERATION_ID` for an authorized guarded recovery.

## Boundaries

- Cleaning is optional. Do not transform already-normalized input without a
  user requirement.
- Do not parse or rewrite large exports record by record in model context.
- Do not use private APIs, document storage, native Node tools, or shell loops
  that issue multiple mutations.
- One source, including 100 dates, uses one `outline diff` and one `outline
  apply`. It is append-only import, not synchronization or deduplication.
- Stop before writing when coverage is unresolved, a source-specific structure
  needs a product choice, the Diff differs from reviewed evidence, or selectors
  are ambiguous.

Read [references/validation-and-coverage.md](references/validation-and-coverage.md)
for coverage failures and [references/tana-export-notes.md](references/tana-export-notes.md)
for Tana-specific mapping decisions.
