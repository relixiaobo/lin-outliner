# Outline Agent Interface Contract

## Goal

Make the public `outline` CLI a task-complete Agent interface: the built-in
Skill chooses the shortest safe workflow, common structured inputs come from
small executable recipes, and every success or failure returns the bounded
information required for the next valid step. Ordinary exact-target work must
not require schema exploration, temporary files, helper programs, or a repeated
command solely to recover a hidden identifier.

This plan is **one complete feature in one PR**. Input narrowing, recipes,
receipts, errors, Skill cleanup, package-boundary cleanup, specifications, and
workflow verification ship together; none improves the observed Agent workflow
as a standalone foundation.

- **OBJ-1:** Reduce the exact-destination viewed-tree workflow from the observed
  fourteen Provider tool calls to Skill load, one mutation, and one independent
  verification.
- **OBJ-2:** Make default CLI output closed-loop: it either completes the task or
  contains every handle required by its documented next command.
- **OBJ-3:** Make executable recipes, not full JSON Schema, the normal discovery
  path while retaining exact schemas and `--json` for integrations.
- **OBJ-4:** Establish one authoritative contract graph for CLI help, examples,
  Skill snippets, presentation coverage, and tests.

## Non-goals

- Do not expose Outline as dozens of MCP, function, or document-native Agent
  tools; the boundary remains `bash` plus `outline` so unrelated Turns carry no
  Outline schema tax.
- Do not add natural-language CLI parsing or a second workflow engine. Recipes
  describe existing porcelain and ChangeSet invocations.
- Do not remove complete schema/JSON output or weaken cardinality, bounds, Diff
  review, destructive acknowledgement, idempotency, recovery, or guarded revert.
- Do not change Core commands, persistence, Runtime transaction semantics,
  renderer behavior, generic Bash projection, or Agent protocol.
- Do not keep compatibility-only structured input forms. Tenon is pre-release;
  callers and fixtures move to the final contract in the same change.
- Do not use lower token consumption as proof of correctness; final state,
  Operation count, recovery, and independent verification remain required.

## Design

### 1. Selected Architecture

Build a **self-describing CLI with closed-loop receipts**. Skill-only examples
would drift, smaller schemas would still require discovery calls, and individual
model tools would add baseline schema cost to every eligible Turn.

The final interface has four invariants:

1. Known intent routes directly from Skill to one narrow command.
2. Unknown structured shape uses one exact `outline example` recipe.
3. Invalid input returns its concrete correction or narrowest discovery step.
4. Successful output includes every identifier, hash, artifact, omission marker,
   and recovery coordinate needed next.

`outline schema` becomes an explicit integration/debugging surface, not an
ordinary Agent step. The Skill uses it only for an uncovered machine contract or
an explicit user request.

### 2. Executable Recipes And Narrow Inputs

Add a typed `OutlineRecipe` registry beside the capability registry. Each recipe
owns stable command/variant identity, intent, direct command, optional literal
stdin, expected receipt family, verification command, and any review or
settlement rule. Production parsers/builders validate every recipe.

Expose it locally without starting Runtime:

```sh
outline example add viewed-tree
outline example find named-counts
outline example commit dependent-change
outline --json example add viewed-tree
```

Default output contains bounded `Command`, `Stdin`, `Result`, and `Verify`
sections. Exact help lists recipe variants instead of imaginary input files. The
initial registry covers viewed/typed-tree add, canonical and batch counts,
bounded-many mutation, complete search create/set, capture, dependent commit,
reviewed Diff/apply, and import plan/verify. A new structured variant requires a
recipe or an explicit machine-only exemption.

Separate porcelain authoring inputs from generic ChangeSet targets:

- `ExactLocatorInput` is an ID, typed ID, stable alias, or
  `@date:YYYY-MM-DD` string and always lowers to cardinality `one`.
- `BoundedSelectionInput` admits search/query selection only for commands that
  genuinely support bulk work and always carries explicit cardinality and `max`.
- Generic ChangeSets retain the complete `TargetRef`, binding, and query graph.

Exact-only porcelain schemas must not embed `QueryExpression`. Viewed-tree
placement becomes:

```json
{
  "kind": "viewed-tree",
  "placement": { "kind": "first", "parent": "@today" },
  "title": "Prices",
  "fields": [
    { "key": "price", "name": "Price", "config": { "fieldType": "number" } }
  ],
  "items": [{ "content": "Item A", "values": { "price": 12 } }],
  "view": { "mode": "table" }
}
```

The CLI normalizes locators before constructing the existing ChangeSet; no new
Runtime request exists. A dynamic one-target query is resolved to an exact ID
before porcelain mutation or expressed as a generic reviewed ChangeSet.

### 3. Exhaustive Success And Failure Receipts

Every non-stream capability declares one receipt family in the executable
registry. `renderSummaryResult` dispatches exhaustively; a registered result may
not fall through to `Result: object` or require `--json` repetition.

| Receipt | Minimum default fields |
| --- | --- |
| Status | running/version identity, revision, health and blocked/degraded reason |
| Projection/count/view | revision, result/count/state, continuation, omissions, complete-set digest |
| Diff | Diff/ChangeSet hashes, base, effects, destructive classes, bindings, warnings, omissions |
| Mutation/history | status, Operation/idempotency identity, revisions, affected digest, roots, recovery |
| Asset/artifact | lease/asset ID or path, type/bytes, expiry or digest |
| Import | profile/coverage, artifacts/hashes, Diff/Operation identity, dates, warnings, verification |

All porcelain previews use the Diff receipt. `log --idempotency-key` exposes the
Operation ID needed for settlement recovery. Asset and import receipts expose
their immediate downstream handles. Raw records/bytes require explicit `--json`
or `--output -`; file exports return artifact receipts; watch summary mode emits
bounded event receipts.

Default failures render up to eight path-specific schema issues, bounded
missing/candidate IDs, expected/actual conflict identities, revert-conflict Node
IDs, settlement idempotency key plus exact `log` command, and actionable file
causes. They never echo rejected input. Guidance orders direct correction,
matching recipe, exact command schema, then root help only when the family is
unknown. Stream errors use the same presenter.

Every recipe, success receipt, and failure receipt is deterministic, valid
UTF-8, ANSI-free, safe against forged lines, and at most 4 KiB. Omitted tails
carry count and digest; review-critical omission requires narrowing or explicit
JSON rather than inference.

### 4. Skill And Package Boundaries

The built-in Skill becomes a policy router containing only exact-target/read
rules, the first-match intent table, direct Bash/stdin transport, one validated
minimal viewed-tree example, review/recovery rules, and narrow verification. It
remains inline, stays below 8 KiB, and does not tell the Agent to read bundled
references or fixtures. The embedded example is generated or byte-checked
against the recipe registry.

Make `src/main/builtInSkills/outline/` a Skill-only package:

- move import adapters to `src/outline/import/adapters/` and package them as
  Outline runtime resources;
- move import and viewed-tree fixtures to `tests/fixtures/outline/`;
- fold maintained ChangeSet/import behavior into `docs/spec/commands.md`;
- retire packaged `commands.md`, `changesets.md`, and `import.md` references.

`scripts/sync-built-in-skills.ts` stays generic; the source directory simply no
longer contains developer or runtime assets. The build and runtime path resolver
point directly at the relocated adapter.

Full schemas remain exact and self-contained under the existing 512 KiB limit.
Reusable definitions emit once under `$defs`; exact-only schemas exclude query
grammar. Per-capability byte baselines detect unreviewed growth without treating
an intentional full schema as Agent prompt material.

### 5. Requirements And Verification

- **FR-1:** The registry provides validated bounded recipes for common structured
  variants without a clearer argv form.
- **FR-2:** Porcelain uses exact locator strings and admits query selection only
  through explicitly bounded forms.
- **FR-3:** Every registered result has a sufficient exhaustive default receipt.
- **FR-4:** Every failure exposes bounded corrective detail and the narrowest
  valid recovery command without echoing input.
- **FR-5:** The Skill routes direct work without runtime reference discovery.
- **FR-6:** Skill instructions, import adapters, maintained docs, and fixtures
  have separate source/package ownership.
- **NFR-1:** Recipes and receipts are capped at 4 KiB; the Skill is capped at
  8 KiB.
- **NFR-2:** Atomicity, bounds, review, idempotency, recovery, full JSON/schema
  fidelity, and independent verification remain unchanged.

Golden traces record command count, model-visible bytes, mutation/Operation
count, required handles, recovery behavior, and final state:

- **FLOW-1:** exact viewed-tree uses Skill, one add, and one view inspection;
- **FLOW-2:** unfamiliar structured work adds one recipe call, not schema;
- **FLOW-3:** invalid input needs one corrective failure and one retry;
- **FLOW-4:** destructive preview exposes the hash applied exactly once;
- **FLOW-5:** unknown settlement resolves through one summary `log` read;
- **FLOW-6:** asset ingest feeds a reviewed Source mutation without `--json`;
- **FLOW-7:** import inspect/plan/apply/verify uses bounded sufficient receipts.

One provider-level replay of the weather request records uncached input, cache
read, output, visible bytes, calls, wall time, and correctness as release
evidence. Deterministic CLI traces, not model sampling, are the test gate.

### 6. Implementation Boundary

Foundation precedes consumers inside the single PR:

1. narrow locator/selection contracts, receipt metadata, and recipes;
2. porcelain lowering and local `example` parsing;
3. exhaustive success, failure, stream, asset, history, and import presentation;
4. Skill rewrite and Skill/runtime/test resource separation;
5. specs, generated-artifact cleanup, golden traces, and schema residue audits.

Expected files are `src/outline/contract/{schemas,porcelain,capabilities}.ts`
plus one recipe module; `src/outline/cli/{arguments,porcelain,presentation,runner,import}.ts`;
`src/outline/import/adapters/**`; `src/main/builtInSkills/outline/**`;
`src/main/outlineRuntime.ts`; `src/outline/bin/outline`; the Outline build entry
in `package.json`; `scripts/sync-built-in-skills.ts`; focused Core tests and
fixtures; and `docs/spec/{commands,agent-skills,agent-tool-design}.md`.

The PR does not touch Core protocol files, `src/outline/runtime/**`, renderer,
generic Agent execution/context, `bun.lock`, `docs/TASKS.md`, or `CHANGELOG.md`.
The dependency-free `package.json` build-path change is declared as an
infrastructure-ownership exception in the Draft PR.

### 7. Risks And Collision Result

- **RISK-1:** Broad porcelain contract edits use an artifact-derived queue from
  schema symbols, generated capability output, fixtures, and failing tests; done
  is an empty residue search.
- **RISK-2:** Receipt coverage is enforced by mandatory capability metadata and
  generated valid-result presentation tests.
- **RISK-3:** Recipe drift is blocked by production parsing/lowering tests and
  representative real-Runtime execution.
- **RISK-4:** Over-compression is blocked by required fields per receipt family
  and explicit omission evidence.
- **RISK-5:** Adapter relocation is covered in dev resolution, generated build,
  and packaged Outline smoke tests.
- **RISK-6:** Call reduction cannot replace persisted-state and exact-Operation
  assertions.

The collision self-check found no overlap: open PRs #611 and #616 do not touch
Outline, and the board marks the public Outline CLI and built-in Skill lane
clear. Re-run the PR/file-scope check before opening the Draft PR.

## Open questions

There are no unresolved product questions. Ratification accepts `outline
example`, narrow exact-locator porcelain inputs, exhaustive default
receipts/errors, the Skill-only package boundary, and removal of superseded
pre-release structured forms as one feature. Private type and module names may
change without changing those observable decisions.

## Acceptance Criteria

- [ ] **AC-1:** FLOW-1 uses exactly three Provider tool calls and one Operation.
- [ ] **AC-2:** FLOW-1 uses zero help, schema, reference, fixture, file-tool,
  temporary-file, pipeline, heredoc, substitution, or helper-program calls.
- [ ] **AC-3:** `outline example add viewed-tree` is at most 4 KiB and its stdin
  validates and lowers through production code.
- [ ] **AC-4:** Every registered structured variant has a validated recipe or
  machine-only exemption, and exact help names its recipes.
- [ ] **AC-5:** Exact-only porcelain schemas contain no query grammar; every
  bounded-many form requires `max`.
- [ ] **AC-6:** Invalid input prints bounded path-specific issues and the
  narrowest correction without echoing the input.
- [ ] **AC-7:** No registered result or preview produces `Result: object` or
  `Details: rerun with --json`.
- [ ] **AC-8:** Diff receipts expose all hash, review, warning, binding, and
  omission facts needed for exact apply.
- [ ] **AC-9:** History, asset, status, export, and import summaries expose their
  downstream handles without JSON repetition.
- [ ] **AC-10:** All recipe and receipt outputs satisfy their byte, encoding,
  control-character, determinism, and omission contracts.
- [ ] **AC-11:** The Skill is at most 8 KiB, contains the validated direct table
  path, and links to no runtime reference or fixture instruction.
- [ ] **AC-12:** The packaged Skill contains no maintainer docs, fixture, or
  executable adapter; dev and packaged imports resolve the relocated adapter.
- [ ] **AC-13:** Schema-size reporting covers all capabilities, exact schemas
  exclude query grammar, and reusable definitions do not expand repeatedly.
- [ ] **AC-14:** FLOW-2 through FLOW-7 pass their call, byte, settlement,
  recovery, handle, and persisted-state assertions.
- [ ] **AC-15:** Current specs contain the final contracts and no superseded
  runtime references or file-based `--input` examples remain live.
- [ ] **AC-16:** Run `bun run typecheck`, focused Outline/Skill/import tests,
  `bun run test:core`, `bun run docs:check`, packaged Outline smoke coverage,
  generated drift checks, and `git diff --check`.
