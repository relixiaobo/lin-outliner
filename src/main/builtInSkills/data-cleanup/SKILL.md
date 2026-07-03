---
description: Clean, normalize, preview, and stage external note/data exports for Tenon. Use when the user asks to import, migrate, clean up, normalize, organize, or reshape exported notes/data from Tana, Roam, Obsidian, OPML, CSV/JSON, or an unknown local format. Known routes must emit Import Pack v1 before calling data_import.
allowed-tools: file_read, file_glob, file_grep, bash, ask_user_question, data_import, node_search, node_read, node_edit, node_delete
---

# Data Cleanup

Use this skill as a data-cleanup workflow, not as a source-specific importer.
Importing is the final step: inspect the source, profile it, ask what to
preserve, run a deterministic route when available, preview the cleaned shape,
then stage the result through `data_import`.

## Workflow

1. Resolve the source file or folder and inspect it with
   `{baseDir}/scripts/inspect-source.ts`.
2. Read the source profile. Do not read a large export wholesale into model
   context.
3. Ask the user only for real cleanup choices: destination, fidelity, date
   handling, tag/field handling, and whether to proceed after preview.
4. For Tana exports, run `{baseDir}/scripts/tana-to-import-pack.ts` to create
   Import Pack v1 and coverage sidecar files. Roam EDN is profile-only in this
   release; do not write Roam data unless a deterministic adapter exists.
5. Run `{baseDir}/scripts/validate-import-pack.ts`.
6. Run `{baseDir}/scripts/import-pack-preview.ts` and show the stats, coverage,
   warnings, and representative samples.
7. Call `data_import` with `dry_run: true`.
8. After the user approves the preview, call `data_import` again with
   `confirmed_preview_id`.

## Boundaries

- Scripts may inspect, clean, normalize, validate, and preview. They must not
  mutate the Tenon document.
- The model coordinates the workflow and explains choices. It must not manually
  parse or rewrite large exports record by record.
- Every supported write route must produce Import Pack v1 with coverage
  accounting. `coverage.unaccounted` must be zero.
- `data_import` is the only bulk document mutation path for cleaned import data.
- Stop before writing if the source profile is low-confidence, the preview shows
  unsupported structures the user has not accepted, or validation fails.

## References

- Read `references/import-pack.md` when implementing or checking an adapter.
- Read `references/validation-and-coverage.md` when investigating dropped,
  unsupported, or mismatched records.
- Read `references/tana-export-notes.md` for Tana-specific cleanup rules.
