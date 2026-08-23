---
description: Clean, normalize, preview, and import external note/data exports into Tenon. Use when the user asks to import, migrate, clean up, normalize, organize, or reshape exported notes/data from Tana, Roam, Obsidian, OPML, CSV/JSON, or an unknown local format. Known routes must emit Import Pack v1 before committing through tenon-import.
allowed-tools: file_read, file_glob, file_grep, bash, request_user_input, node_search, node_read, node_edit, node_delete
execution: isolated
---

# Tenon Data Cleanup and Import

Use this skill as Tenon's data-cleanup and import workflow, not as a
general-purpose data-cleaning skill or a source-specific importer. Importing is
the final step: inspect the source, profile it, infer what to preserve, run a
deterministic route when available, validate the cleaned shape, then import the
result through `tenon-import`.

## Workflow

1. Resolve the source file or folder and inspect it with
   `tenon-import inspect <source> --out <profile.json>`.
2. Read the source profile. Do not read a large export wholesale into model
   context.
3. Infer destination, fidelity, date handling, and tag/field handling from the
   request and source profile. Ask only for a required choice that cannot be
   inferred; preview approval is not a separate permission step.
4. For Tana exports, run `tenon-import tana <source> --out <pack.json>
   --coverage-out <coverage.json>` to create
   Import Pack v1 and coverage sidecar files. Roam EDN is profile-only in this
   release; do not write Roam data unless a deterministic adapter exists.
5. Run `tenon-import validate <pack.json> --out <report.json>`.
6. Run `tenon-import preview <pack.json> --out <preview.md>` and inspect the
   selected mode, stats, coverage, warnings, representative samples, affected
   date range, existing/new Daily Note counts, and returned preview id. Tana
   `journalPart` dates default to `native_daily`; use `--mode stage` only when
   the user wants one staging tree instead.
7. When the original request authorizes importing and the preview passes the
   gates below, run `tenon-import commit <pack.json> --preview-id <preview:id>`
   without a second confirmation. Repeat the preview's explicit `--mode`
   override on commit; preview IDs are bound to the selected mode.
8. Inspect the commit JSON. `status: "staged"` or `"imported_daily"` completes
   the import. If the command exits non-zero with
   `data.status: "staged_with_errors"` or
   `"imported_daily_with_errors"`, stop. Do not retry the commit or manually
   delete created content. Report the returned `createdRootIds`, optional
   `stagingRootId`, `dailyTargets`, `operationId`, and `mismatches` to the parent
   Agent.

## Boundaries

- Scripts may inspect, clean, normalize, validate, and preview. They must not
  mutate the Tenon document.
- The model coordinates the workflow and explains choices. It must not manually
  parse or rewrite large exports record by record.
- Every supported write route must produce Import Pack v1 with coverage
  accounting. `coverage.unaccounted` must be zero.
- `tenon-import commit` is the only bulk document mutation path for cleaned
  import data. It calls the running Tenon app; scripts must not write document
  storage directly.
- Native Daily Note imports are append-only. Re-importing the same pack creates
  another copy; never describe this mode as synchronization or deduplication.
- A verification mismatch has already written one import operation. Preserve
  its created content for inspection and do not create another copy. The parent
  Agent may request an exact undo with `outline_undo_stack` using
  `action: "undo"` and `operation_id: <operationId>`. If that operation is no
  longer the stack top, the guarded undo is rejected; never replace it with an
  unguarded undo.
- Stop before writing if validation fails. If the source profile is
  low-confidence or unsupported structures create a material cleanup choice,
  ask only for that unresolved choice; otherwise report dropped/unsupported
  coverage and continue according to the requested fidelity.

## References

- Read `references/import-pack.md` when implementing or checking an adapter.
- Read `references/validation-and-coverage.md` when investigating dropped,
  unsupported, or mismatched records.
- Read `references/tana-export-notes.md` for Tana-specific cleanup rules.
