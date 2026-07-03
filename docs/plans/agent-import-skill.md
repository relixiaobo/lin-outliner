# Agent Data Cleanup and Import Skill

Give Neva a built-in workflow for turning messy external data into clean Tenon
outline content. Importing is the final step of the workflow, not the product
identity: the skill profiles a source, cleans and normalizes it, asks the user
which shape to preserve, previews the result, then stages the cleaned outline for
review.

Tana is the first deterministic route because we have real export evidence and a
clear migration use case. Roam, Obsidian, OPML, CSV/JSON, and one-off unknown
formats can reuse the same cleanup workflow later.

## Goal

- Ship one complete feature in one PR: a built-in **data-cleanup/import** skill
  with a versioned Tana route, deterministic cleanup scripts, a preview report,
  and one generic `data_import` interface that writes cleaned data into Tenon.
- Treat the skill as a data-wrangling workflow:
  source profile -> cleanup plan -> user choices -> normalized preview -> Import
  Pack -> direct import -> user review.
- Keep public tool coupling low. The skill depends on one semantic write
  boundary: clean source data into Import Pack v1, then call the generic import
  interface. It must not stitch large imports together through many low-level
  node tools.
- Preserve the user-visible dimensions that mattered in the real Tana export:
  outline text, descriptions, code blocks, date grouping, tags, checkbox/done
  state, inline references when resolvable, and fields when the user asks for
  high fidelity.
- Make large-source handling deterministic and bounded: sample before loading,
  write normalized Import Pack artifacts to files, validate the pack before
  writing, and report stats/warnings before any document mutation.
- Keep deterministic work in scripts and judgment work in the model. Scripts
  inspect, transform, validate, and preview; the model coordinates the workflow,
  explains choices, and asks the user for cleanup intent.
- Make the import interface format-agnostic. Tana, Roam, Obsidian, CSV/JSON, and
  future unknown-format cleanup routes all converge on the same Import Pack
  contract before they can write to the document.
- Require coverage accounting for every source record so imported, merged,
  dropped, unsupported, and empty records are all explainable before write.

## Non-goals

- No dedicated import UI panel. The MVP is a built-in skill workflow in the agent
  surface.
- No Tana-specific import tool. The write boundary is a generic `data_import`
  interface that accepts Import Pack v1 and destination/staging options.
- No direct document writes from adapter scripts. Scripts may inspect, clean,
  normalize, and emit Import Packs; only the import interface mutates Tenon.
- No service/API import or OAuth import. File exports only.
- No automatic unknown-format write path. Unknown formats may be profiled and
  cleaned into a preview artifact later, but this PR only writes via the Tana
  deterministic route.
- No agent-authored adapter persistence in this PR. Saving a working ad-hoc
  parser as a reusable adapter belongs with the governed skill-authoring /
  self-modification track.
- No hidden cross-clone handoff from `tmp/`. All reusable adapter code, fixtures,
  and schema notes needed by the building clone must be versioned in the repo or
  in an enabled built-in skill resource.
- No model-managed low-level node creation for bulk imports. The agent should not
  create a 10k-node import by looping over `node_create`; the import interface is
  responsible for validation, batching, document transactions, progress, and
  rollback semantics.

## Design

### 1. Built-in skill shape

Add a resource-backed built-in skill, tentatively `/data-cleanup`, with
Tana-import guidance as one route. The skill name should describe the broad job
instead of the first adapter.

The skill should trigger when the user asks to import, clean up, normalize,
organize, migrate, or reshape exported notes/data for Tenon. It should not
trigger for ordinary spreadsheet analysis, charting, or statistical exploration;
those stay with `/data-analysis`.

The skill body should avoid baking in implementation-specific tool contracts.
Write it in capability terms:

- inspect files and sample large sources;
- run the deterministic adapter script for known formats;
- ask the user for cleanup choices;
- write normalized preview artifacts;
- call the import interface with the validated Import Pack;
- stop before any irreversible or ambiguous write.

In Tenon today those capabilities map to local file access, script execution,
user-question flow, and the generic import interface, but the skill should
remain readable if individual tool names evolve.

### 2. Workflow

The skill runs the same high-level workflow for every route.

1. **Identify and bound the source.** Resolve the user-provided file/folder,
   confirm it is inside an allowed file root, and inspect top-level file names,
   sizes, extensions, and a bounded sample. Never read a large export wholesale
   into model context.
2. **Profile.** Produce a compact source profile: detected format, record/node
   counts, date range, likely text fields, tags/classes, field-like metadata,
   media/link counts, unsupported structures, and confidence.
3. **Ask for cleanup intent.** Use `ask_user_question` for real choices:
   destination/staging parent when not obvious, fidelity tier, date handling,
   tag/field handling, and whether to proceed after preview. Keep the fallback as
   ordinary conversation only for non-Tenon-compatible future hosts, not as a
   Tenon MVP path.
4. **Normalize.** Run the adapter into a repo-owned Import Pack JSON plus a human
   preview Markdown report and coverage report. The model reads the reports, not
   the full pack.
5. **Preview.** Call `data_import` in `dry_run` mode to validate the pack and
   receive a preview id, then show stats, warnings, dropped content, and
   representative samples. The user approves the write after seeing the cleaned
   shape. This is product confirmation for the cleaned import shape, not a
   substitute for tool permission approval.
6. **Import.** Pass the validated Import Pack path to the generic import
   interface. The interface creates a staging root such as
   `Import: tana-export (2026-07-03)`, writes the cleaned sections, records stats, and
   returns created roots/warnings/progress. Prefer a user-chosen parent or a
   discoverable Library/Imports parent; otherwise use today's journal node and
   make the staging root explicit.
7. **Review and refine.** The staged content is normal Tenon outline content, so
   the user and agent can use existing node tools to move, edit, delete, tag, or
   re-run at a different fidelity.

### 3. Program/model responsibility split

The skill must not rely on the model to parse large exports, count records, or
decide whether every item was preserved. The model coordinates the data-cleanup
workflow; scripts and the import interface perform deterministic data work.

Program-owned responsibilities:

- sample and profile source files without loading large exports into context;
- parse known formats and produce Import Pack v1;
- maintain source-record coverage accounting;
- validate Import Pack schema, bounds, references, and invariants;
- generate compact preview reports and representative samples;
- compare dry-run, pack, and post-import counts.

Model-owned responsibilities:

- infer the user's cleanup goal from the request and source profile;
- explain fidelity choices and tradeoffs in user language;
- ask for destination, fidelity, date, tag, field, and proceed/stop choices;
- summarize warnings and dropped/unsupported structures from reports;
- choose the deterministic route when confidence is high, or stop with a clear
  unsupported/unknown-format recommendation when it is not.

The model may author or revise an exploratory parser only outside this MVP's
write path. For this release, any data that writes to Tenon must come from a
tracked deterministic adapter and must pass Import Pack validation.

### 4. Tana deterministic route

Ship Tana as the first known-format adapter.

The adapter is versioned code, not a copied `tmp/` artifact. Move the useful
logic from the historical `tmp/tana-import/import-tana.ts` experiment into a
tracked adapter script and add small anonymized fixtures that exercise the real
shapes.

The route supports three presets, each implemented as adapter options and
reported in the preview:

| Tier | Text/outline | Descriptions | Code | Date grouping | Tags | Done/checkbox | Inline refs | Fields |
|---|---|---|---|---|---|---|---|---|
| Content | Yes | Yes | Yes | Yes | No | Optional text | Flattened | No |
| Clean | Yes | Yes | Yes | Yes | Normalized tags | Checkbox state | Flattened/resolved when safe | Text children |
| Full | Yes | Yes | Yes | Yes | Normalized tags | Checkbox state | Resolved when safe | Field rows |

The historical real-export measurements still explain the defaults:
tags are common, descriptions are real body text, checkbox/done state is worth
preserving, inline refs are rare enough to handle quietly, and images/URLs are
low-volume. Do not preserve Tana internals for their own sake; preserve the user
meaning in Tenon's model.

Tana cleanup rules:

- decode HTML/entities and trim generated noise;
- preserve descriptions as Tenon descriptions when they are metadata/body text,
  not as arbitrary child notes;
- represent code blocks as code rows with language when known;
- group journal/date-bearing content under explicit `YYYY-MM-DD` staging
  headings;
- skip day/week tags when date grouping already carries that meaning;
- normalize tag names and report collisions;
- map done/checkbox to Tenon checkbox state for imported tasks;
- for fields, prefer Tenon `Field:: value` rows only at the Full tier; Clean
  tier degrades fields to readable child text;
- record unsupported or dropped structures in warnings.

### 5. Import Pack

Adapters emit an Import Pack owned by this skill and the import interface, not by
`src/core/types.ts`. The runtime schema can live in main-process import code and
be documented in the skill resource; it should not become a core document
protocol unless a later measured implementation proves that is necessary.

```ts
interface ImportPack {
  version: 1;
  source: {
    kind: string; // adapter/source family, e.g. "tana"
    path: string;
    sourceId?: string;
  };
  options: ImportOptions;
  stats: ImportStats;
  coverage: ImportCoverage;
  warnings: ImportWarning[];
  sections: ImportSection[];
}

interface ImportSection {
  id: string;
  title: string;
  kind: "library" | "date" | "other";
  date?: string; // YYYY-MM-DD for kind "date"
  nodes: ImportNode[];
}

interface ImportNode {
  title: string;
  description?: string;
  tags?: string[];
  checked?: boolean;
  code?: { language?: string; text: string };
  fields?: { name: string; values: string[] }[];
  children?: ImportNode[];
  sourceId?: string;
}

interface ImportOptions {
  fidelity: "content" | "clean" | "full";
  dateGrouping: "stage_headings" | "none";
  tags: boolean;
  fields: "omit" | "text_children" | "field_rows";
  doneState: boolean;
}

interface ImportStats {
  sourceRecords: number;
  sections: number;
  nodes: number;
  descriptions: number;
  tags: number;
  fields: number;
  checked: number;
  dropped: number;
}

interface ImportCoverage {
  imported: number;
  merged: number;
  dropped: number;
  unsupported: number;
  empty: number;
  unaccounted: number; // must be 0 before dry-run can pass
  entriesFile?: string; // sourceId -> status report for large imports
}

interface ImportWarning {
  code: string;
  message: string;
  sourceId?: string;
  count?: number;
}
```

The pack intentionally mirrors Tenon's importable outline model rather than core
command types. Keeping the pack skill-local avoids making every source format a
protocol-surface change while still giving tests and the import interface a
stable adapter contract.

Coverage rules:

- every source record with a stable source id must be classified as `imported`,
  `merged`, `dropped`, `unsupported`, or `empty`;
- `dropped` and `unsupported` entries require structured warning codes and
  counts, with representative source ids in the preview report;
- `merged` entries must identify the imported node or structure they were folded
  into, such as description text, a field row, a tag, or a date heading;
- `unaccounted` must be zero for dry-run and write paths;
- large imports may keep the full sourceId -> status table in a sidecar file,
  but the pack must carry aggregate counts and the sidecar path.

### 6. Integrity and validation gates

The import is not successful merely because some nodes were created. Success
requires four explicit gates:

1. **Source profile gate.** `inspect-source` records file size, source record
   count, format confidence, date range, likely tags/fields/descriptions/code,
   and unsupported structures before the adapter runs.
2. **Transform gate.** The adapter emits Import Pack v1, a preview report, and a
   coverage report. The sum of `imported + merged + dropped + unsupported +
   empty` must equal `sourceRecords`, and `unaccounted` must be zero.
3. **Dry-run gate.** `data_import` validates schema, bounds, destination, pack
   hash, coverage totals, and invariant rules before returning a `previewId`.
   Dry-run must not mutate the document.
4. **Post-import verification gate.** After a write, the interface reads back the
   created staging subtree and compares created sections/nodes plus
   descriptions, tags, fields, code blocks, checkbox states, warnings, and
   operation-history behavior against the pack and dry-run result.

Validation failures block mutation when they happen before write. Post-import
verification failures return an explicit failed-verification result with created
ids and rollback/cleanup guidance; they must not be reported as a clean import.

### 7. Generic `data_import` interface

All imported data writes go through one generic `data_import` interface. The
interface is not a Tana adapter and not a general-purpose node batch editor; it
is the boundary that turns a validated Import Pack into Tenon nodes.

Model-facing shape:

```ts
interface DataImportInput {
  pack_file: string;
  mode?: "stage"; // v1 only
  parent_id?: string; // default: today's journal node
  dry_run?: boolean;
  confirmed_preview_id?: string;
}

interface DataImportResult {
  importId: string;
  previewId?: string;
  stagingRootId?: string;
  sectionCount: number;
  nodeCount: number;
  createdRootIds: string[];
  warnings: ImportWarning[];
  stats: ImportStats;
  operationId?: string;
}
```

Interface responsibilities:

- read the Import Pack from a path instead of accepting huge inline JSON;
- resolve `pack_file` through the same realpath-based local-root / scratch /
  handed-scope boundary as the typed file tools, so the interface is not a file
  read bypass;
- validate pack version, schema, bounds, and destination before mutating;
- reject packs with missing or inconsistent coverage accounting;
- return a `previewId` from dry-run validation and require it as
  `confirmed_preview_id` for non-dry-run writes, after the skill shows the
  preview and the user approves it;
- bind `previewId` to the pack hash, import options, destination parent, and run
  scope so a stale confirmation cannot approve different content;
- create one explicit staging root;
- materialize descriptions, tags, fields, checkbox state, code blocks, and
  section/date headings using TypeScript-owned parsing/application;
- batch internally and report progress without exposing low-level node operations
  to the model;
- verify the created staging subtree after write and report any mismatch between
  pack counts, dry-run counts, and actual created content;
- wrap the import in a coherent document transaction where the current operation
  history can support it, or return an explicit rollback limitation in the
  preview/result;
- register permission/action metadata as `outline.edit`, with permission copy
  that names this as a bulk local document import;
- keep the interface format-agnostic so future adapters reuse it unchanged.

Implementation route:

- Prefer implementing the interface in main-process TypeScript beside the agent
  node tools, backed by existing document commands and host transactions.
- Keep the model-visible result compact: ids, counts, warnings, and next actions;
  the full Import Pack and source paths stay in tool details or files, not echoed
  wholesale into the model-visible payload.
- Do not change `src/core/commands.ts` or `src/core/types.ts` unless a measured
  implementation proves a core command is required for correctness or acceptable
  performance.
- If a core command becomes necessary, stop for ratification and land the
  interface/protocol change first.

### 8. Skill resources and packaging

Ship this as a resource-backed built-in skill so adapter code versions with the
app and works in packaged builds.

Expected layout:

```text
src/main/builtInSkills/data-cleanup/
  SKILL.md
  references/
    import-pack.md
    validation-and-coverage.md
    tana-export-notes.md
  scripts/
    import-pack-lib.ts
    inspect-source.ts
    tana-to-import-pack.ts
    validate-import-pack.ts
    import-pack-preview.ts
  fixtures/
    tana-minimal.json
    tana-fields-and-tags.json
```

If the scripts are broadly reusable outside Tenon, they may later move to
`linlab-skills` and be enabled through the existing built-in skill staging list.
For this first Tenon-specific route, keep them in the Tenon repo so the app,
tests, and plan evolve together.

Script responsibilities:

- `inspect-source.ts` profiles files and produces a compact source profile.
- `tana-to-import-pack.ts` converts Tana exports to Import Pack v1 plus coverage
  accounting.
- `validate-import-pack.ts` validates schema, invariants, bounds, and coverage.
- `import-pack-preview.ts` produces a human/model-readable preview report so the
  full pack does not need to enter model context.

### 9. Tests and verification

Adapter tests:

- Tana fixture -> Import Pack stats and warnings.
- Description, code block, tag, checkbox, inline reference, date section, and
  field downgrade/full-field cases.
- Large-file sampling path does not load the whole export into model context.
- Source-record coverage sums exactly to sourceRecords, with zero unaccounted
  records.

Import interface tests:

- Import Pack dry-run validates stats and warnings without document mutation.
- Import Pack import creates staged outline content with descriptions, tags,
  fields, code, date headings, and checkbox state.
- Invalid pack versions, oversized sections, malformed fields, and invalid
  destinations fail before mutation.
- Missing, inconsistent, or non-zero-unaccounted coverage fails before mutation.
- Post-import verification detects mismatched node, description, tag, field,
  code, checkbox, and warning counts.
- Mid-import failures either roll back coherently or report the precise rollback
  limitation and created staging root.

End-to-end smoke:

- User invokes `/data-cleanup` for a fixture Tana export.
- The skill profiles the export, asks fidelity/date choices, produces a preview,
  calls the import interface after approval, and reports created staging stats.

Real-export measurement:

- Re-run against the historical `b8AyeCJNsefK@2026-03-01` class of export when
  available to the building agent.
- Record node count, sections, runtime, dropped structures, operation-history
  behavior, and whether the generic import interface meets the acceptance bar.

## Requirements and acceptance criteria

- **FR-1 — Cleanup output boundary.** Every supported source route must emit
  Import Pack v1 before it can write to Tenon.
- **FR-2 — Generic import interface.** `data_import` is the only bulk document
  mutation path for cleaned import data; adapters and skill scripts never mutate
  the document directly.
- **FR-3 — Tana first route.** The first shipped route converts Tana exports into
  Import Pack v1 with the Content, Clean, and Full fidelity options.
- **FR-4 — Preview confirmation.** Non-dry-run imports require a dry-run preview
  id bound to the same pack hash, options, destination, and run scope.
- **FR-5 — Staging-first result.** The import writes an explicit staging root and
  returns created ids, stats, warnings, and next actions for review.
- **FR-6 — Program/model split.** Scripts own deterministic profiling,
  transformation, validation, preview generation, and coverage accounting; the
  model owns user intent, explanation, choice collection, and workflow
  coordination.
- **FR-7 — Coverage accounting.** Every source record must be accounted for as
  imported, merged, dropped, unsupported, or empty before dry-run can pass.
- **NFR-1 — Bounded large-source handling.** The skill samples and profiles large
  exports, keeps full packs in files, and keeps model-visible output compact.
- **NFR-2 — Verifiable import integrity.** Dry-run and post-import verification
  compare source, pack, and created-content counts; mismatches are reported as
  failed verification, not as successful imports.

Acceptance:

- **AC-1:** Given a Tana fixture, the adapter writes a valid Import Pack v1 and a
  preview report without mutating the document.
- **AC-2:** Given a valid pack, `data_import` dry-run returns stats, warnings, and
  a preview id without creating nodes.
- **AC-3:** Given the same pack/options/destination and user confirmation,
  `data_import` non-dry-run creates one staging root with representative
  descriptions, tags, fields, date headings, code, and checkbox state preserved.
- **AC-4:** Given a stale or mismatched `confirmed_preview_id`, `data_import`
  refuses to mutate.
- **AC-5:** Given malformed, oversized, or out-of-scope pack input, `data_import`
  fails before mutation and returns a recoverable error.
- **AC-6:** On the real-export class, measurement records runtime, node count,
  warnings, rollback/operation-history behavior, and any dropped structures.
- **AC-7:** Given any supported source fixture, the transform output includes
  coverage totals whose statuses sum to `sourceRecords`, with `unaccounted = 0`;
  otherwise dry-run refuses to produce a preview id.
- **AC-8:** Given a successful non-dry-run import, post-import verification
  reports matching section/node and preserved-structure counts; if counts differ,
  the result is marked failed verification with created ids and recovery guidance.

## Open questions

- Default staging parent: should the skill always ask, or should Tenon expose
  Library/Imports in the outliner context reminder so the skill can default there
  without search?
- Native date-node merge: is date grouping in staging enough for the first
  cleanup/import release, or does the user need an explicit accept step that
  moves date sections into daily notes?
- Re-import behavior: always stage fresh, or detect prior imports by source hash
  and offer replace/update?
- Import Pack storage: keep preview/pack files in the agent scratch area only, or
  preserve them as local audit artifacts next to the source when the user asks?

## Collision check

Last refreshed 2026-07-03. No open PR currently claims the import/data-cleanup
surface. The only open adjacent PR is #365 (`agent-run-index-completeness`),
which rewrites run/tool vocabulary and agent specs; wait for it to merge or
rebase before finalizing tool names, built-in skill wording, and spec anchors.

This plan touches new built-in skill resources, adapter scripts, tests, the
generic import interface, permission metadata, and agent-skill/tool specs. It
should not touch `src/core/commands.ts` or `src/core/types.ts` unless a measured
implementation proves a core command is required and that protocol change is
ratified first.

## Build checklist

- [ ] Create the resource-backed `/data-cleanup` built-in skill with frontmatter,
      trigger guidance, and the source-profile -> cleanup -> preview -> stage
      workflow.
- [ ] Add tracked Tana adapter resources. Do not depend on `tmp/tana-import`.
- [ ] Define and document Import Pack v1 as a skill-local contract.
- [ ] Implement `inspect-source`, `tana-to-import-pack`,
      `validate-import-pack`, and `import-pack-preview` scripts.
- [ ] Add anonymized Tana fixtures for descriptions, tags, fields, done state,
      date grouping, code, and inline refs.
- [ ] Add coverage accounting for imported, merged, dropped, unsupported, empty,
      and unaccounted source records, with sidecar support for large sourceId
      tables.
- [ ] Implement the generic import interface over Import Pack v1 with dry-run,
      staging write, pack-file boundary checks, preview confirmation, validation,
      coverage checks, permission metadata, progress, post-import verification,
      and operation history behavior.
- [ ] Add adapter, Import Pack validation, import-interface integration, and e2e
      smoke tests.
- [ ] Update `docs/spec/agent-skills.md`, `docs/spec/agent-tool-design.md`, and
      `docs/spec/agent-tool-permissions.md` for the new built-in skill and import
      interface.
- [ ] Measure the real Tana export class before marking the plan shipped.
