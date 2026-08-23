# Native Daily Import

## Goal

Ship one complete feature in one PR: import date-bearing Tana journal content
directly into Tenon's canonical Daily Notes nodes while preserving the existing
staging-tree path for non-date content and explicit staging imports.

The Tana route should make the source's date organization useful immediately:
preview the affected dates, append imported rows under the canonical day nodes,
and keep the whole import behind the same validated Import Pack, main-process
mutation authority, rollback, operation-history, and post-import verification
boundary used by staging imports.

## Non-goals

- No overwrite, replace, merge-by-title, or source-record deduplication. A
  repeated native-daily import appends another copy and the preview warns about
  that behavior.
- No native-date inference for unknown formats. An adapter must emit an explicit
  date section with a valid local calendar date.
- No low-level Agent loop over `ensure_date_node` or node mutation tools.
- No direct script, CLI, persistence-file, or renderer mutation of the outline.
- No new import UI panel or general migration framework.
- No change to `src/core/commands.ts` or `src/core/types.ts`.

## Design

### Product behavior

The import service supports two destinations:

- `stage`: preserve the current behavior by writing every section below one
  explicit `Import: <source>` root under the selected parent.
- `native_daily`: append each `kind: "date"` section directly below its
  canonical Daily Notes day node. Any non-date sections from the same pack are
  written below one staging root, so library content never scatters into the
  document.

The Tana adapter selects `native_daily` as the recommended mode when it emits at
least one journal date. The CLI keeps an explicit `--mode stage|native_daily`
override. Preview output states the selected mode, number and date range of day
targets, how many canonical days already exist, how many will be created, the
non-date staging count, and the append-only re-import warning. Preview identity
remains bound to the pack hash, destination, and mode.

### Tana date sections

`convertTanaExport` recognizes deterministic Tana journal roots and emits one
`ImportSection` per local calendar date:

- `kind` is `date`;
- `date` and `title` use `YYYY-MM-DD`;
- the journal container itself is coverage-accounted as merged into the date
  section rather than materialized as a duplicate visible row;
- its importable descendants become the section's nodes in source order.

All non-journal content remains in a library section. Ambiguous or invalid date
metadata is not guessed: the content stays in the library section and produces
a structured warning. Fixtures record the exact supported Tana date shapes.

### Import transaction

`AgentImportService` validates the complete Import Pack before mutation. Native
daily commit then calls one import-specific main/Core operation that:

1. preflights every section and target date;
2. ensures each canonical year/week/day path through `Core.ensureDateNode`;
3. materializes all date-section rows and the optional non-date staging tree
   with cooperative chunk commits;
4. keeps the chunks inside one rollback frontier, one undo group, and one
   operation-history entry;
5. returns exact imported top-level root ids and per-section target metadata.

An error at any point restores the pre-import frontier, including newly created
date scaffolding. Existing day nodes and their prior children are never removed
or rewritten by commit or rollback.

The implementation extends the internal import host/service seam rather than
adding a public Core command. `DocumentService` remains the main-process
coordinator and Core remains the only document mutation authority.

### Verification and results

Post-import verification traverses only the exact roots created by this import,
not all existing content below affected day nodes. It compares section, node,
description, tag, field, and checked counts with the validated pack and reports
per-date target ids.

The structured result distinguishes:

- created import roots;
- affected canonical day ids;
- newly created versus existing day targets;
- an optional non-date staging root;
- verification mismatches and recovery instructions.

The same result shape is available through the local API and `tenon-import`
JSON output. Human preview/report output stays bounded for large date ranges.

### Files and ownership

Expected implementation surface:

- `src/main/builtInSkills/tenon-import/scripts/tana-to-import-pack.ts`
- `src/main/builtInSkills/tenon-import/scripts/tenon-import.ts`
- `src/main/builtInSkills/tenon-import/scripts/import-pack-preview.ts`
- `src/main/builtInSkills/tenon-import/fixtures/`
- `src/main/builtInSkills/tenon-import/references/`
- `src/main/builtInSkills/tenon-import/SKILL.md`
- `src/main/agent/capabilities/agentDataImportPack.ts`
- `src/main/agent/capabilities/agentImportService.ts`
- `src/main/agent/capabilities/agentImportApi.ts`
- `src/main/agent/capabilities/agentNodeToolTypes.ts`
- `src/main/documentService.ts`
- import, Core transaction, CLI, and built-in Skill tests
- `docs/spec/agent-skills.md` and `docs/spec/architecture.md`

Collision result at approval: `gh pr list` returned no open claims. The fetched
`codex-2/tenon-import-root-bash-integration` branch had no commits relative to
`origin/main`, so it did not overlap any file. Re-run this check before marking
the implementation ready.

### Acceptance criteria

- `convertTanaExport` emits deterministic date sections for supported Tana
  journal fixtures and accounts for every source record with zero unaccounted.
- Previewing `native_daily` performs no document mutation and reports existing
  versus new day targets, date range, non-date staging, and append-only behavior.
- A pack with 102 date sections and approximately 12,000 imported nodes commits
  through one logical operation with cooperative yielding and matching
  post-import verification.
- Existing day content remains byte-for-byte semantically unchanged except for
  appended imported children.
- One undo removes all imported rows and any now-unused date scaffolding created
  by that import while preserving all pre-existing content.
- A failure after at least one chunk commit leaves no imported rows or new date
  scaffolding visible.
- A stale preview id, changed pack, changed mode, invalid date, malformed pack,
  or unavailable destination fails before mutation.
- `stage` mode retains its current staging-tree behavior and verification.

## Open questions

None. The PM approved native Daily Notes as the Tana journal target, with staging
retained as the alternate path. Re-import remains explicitly append-only for
this feature.

## Build checklist

- [ ] Add deterministic Tana journal-date extraction and fixtures.
- [ ] Extend Import Pack mode validation, preview binding, CLI/API arguments,
      and reports.
- [ ] Add one main/Core native-daily import transaction with chunked rollback and
      one undo entry.
- [ ] Verify exact created roots across date and staging destinations.
- [ ] Cover existing/new day targets, mixed sections, failure rollback, staging
      regression, and the 102-day large-pack case.
- [ ] Fold shipped behavior into the current specs and archive this plan at the
      main merge gate.
