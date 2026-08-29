# Outline CLI Skill Workflow Efficiency

## Goal

Make the built-in `outline` Skill choose the shortest correct public CLI path
for ordinary document work, especially field-backed Table View creation. A
prepared view-backed Node tree should require one compact structured stdin
payload, one atomic mutation, and one bounded independent verification instead
of schema exploration, hand-authored row bindings, Diff re-reading, file-tool
choreography, and ad hoc shell analysis.

This plan is **one complete feature in one PR**. The feature includes the Skill
instructions, the public CLI affordances those instructions need, deterministic
human-readable receipts, executable fixtures, current-behavior specifications,
and end-to-end acceptance evidence. None of those parts ships independently:
guidance without the compact `add --input` form leaves the model generating the
same verbose ChangeSet, while a command form the Skill does not select does not
improve the observed workflow. The feature starts only after its external Bash
stdin and Source PR-I dependencies merge; it consumes their public contracts
without defining or implementing either foundation in this plan.

The objectives are:

- **OBJ-1:** Reduce avoidable Provider Calls and model-visible bytes in Outline
  workflows without weakening atomicity, target proof, review, recovery, or
  final-state verification.
- **OBJ-2:** Make native Table View the reliable default whenever the user asks
  for a table, rather than Markdown, aligned text, or ordinary child Nodes with
  no table view definition.
- **OBJ-3:** Keep the public CLI schema-discoverable for unfamiliar work while
  making help and schema lookup an exact recovery path instead of mandatory
  ceremony.

## Non-goals

- Do not change or invoke `file_read`, `file_write`, `file_edit`, `file_grep`, or
  another file tool during an Outline workflow. Their bounded-observation and
  authority-alignment designs are reference philosophy only, not implementation
  dependencies or transport. Shell result projection, the generic Agent
  tool-result allocator, and file-observation authority also remain unchanged.
- Do not change Web tools, untrusted-content framing, loop control, Subagent
  execution or settlement, token accounting, usage UI, context composition, or
  Provider cache behavior.
- Do not add or modify generic Bash transport in this feature. A separate
  plan and Draft claim, [PR #596](https://github.com/relixiaobo/lin-outliner/pull/596),
  own the bounded stdin channel and its security contract. This feature consumes
  that merged interface while its own diff continues to reject every product
  change under `src/main/agent/**`.
- Do not make the Outline Skill `execution: isolated`. It remains inline so the
  current Turn retains user intent, inspected document state, and mutation
  settlement without a second child Turn or result boundary.
- Do not add a document-private Agent tool, scenario-specific Runtime endpoint,
  or privileged Skill API. Every write still lowers to the public ChangeSet and
  every read still uses public Runtime projection/query authority.
- Do not access Outline state through UI automation, direct Runtime requests,
  workspace files, databases, or private application APIs. After loading the
  built-in Skill, every document read, mutation, history action, and recovery
  action is one Bash invocation of the public `outline` executable.
- Do not remove `ChangeSet`, `diff`, or `apply`. They remain the correct public
  path for dependent work not covered by porcelain and for destructive,
  ambiguous, or explicitly review-bound work.
- Do not treat lower token use as proof of success. The persisted table shape,
  exact row and column counts, Operation receipt, recovery state, and an
  independent read remain required evidence.
- Do not prohibit Python, Node, `jq`, `sed`, or `grep` globally. The Outline Skill
  forbids using them, general shell programs, or non-`outline` executables to
  rediscover public Outline schemas, assemble document mutations, inspect
  document storage, or parse routine Outline results. They remain available
  when a non-Outline task genuinely requires them.
- Do not implement Source resources, Agent resource references, preview UI, or
  file lifecycle. Source PR-I is a dependency because it owns the final Node and
  CLI contracts; Source PR-F is not part of this feature.
- Do not add migration, compatibility, dual-read, or legacy fixture paths. This
  pre-release contract follows the repository's clean-reset policy.

## Design

### 1. Evidence And Success Measure

The motivating sanitized development trace is an ordinary request to convert
prepared outline content into a Table View. Its successful Turn made 16 tool
calls and took about 170 seconds. Provider usage recorded 169,105 uncached input
tokens, 737,280 cache-read tokens, and 4,581 output tokens. `totalTokens` is not
used as the optimization target because it mixes cache and uncached traffic.

The avoidable sequence included all of the following:

1. re-reading `references/changesets.md`;
2. re-reading the 216-line generic table ChangeSet fixture;
3. requesting the aggregate `ChangeSet` schema;
4. requesting `diff` and `apply` help already described by the Skill;
5. running several `jq`/`grep` probes against the same schema and Diff;
6. generating one create operation and one update operation per row;
7. reading tens of kilobytes of reviewed Diff back into model context;
8. receiving a large full Operation result; and
9. receiving a large row-and-field Projection for final verification.

The trace is evidence of an Outline workflow failure, not evidence that generic
file tools are defective or should participate in the replacement. The Skill
instructed the model to take the expensive path, and the CLI lacked a compact
public view-backed `add` input and bounded model-facing receipts.

Acceptance compares the Outline-only segment after source data is already
prepared. From workflow selection through independent verification, the
representative table scenario uses only the `skill` tool and Bash invocations
whose executable is `outline`, with at most four Provider tool calls:

1. one invocation that loads the built-in `outline` Skill;
2. zero or one Bash invocation of a bounded `outline --human show` or `find`
   when the destination is not already exact;
3. one Bash invocation whose `command` is `outline --human add --input -` and
   whose separate `stdin` argument is the literal structured payload; and
4. one Bash invocation of `outline --human view inspect OWNER_ID`.

The common exact-destination case therefore uses three calls. It performs zero
file-tool calls and reads no bundled reference or fixture at runtime.

This is a 75% or greater Provider Call reduction from the measured 16-call
baseline. The table payload necessarily scales with user data and is authored
once. Model-visible CLI stdout is independently capped and does not scale with
row count. Verification records uncached input, model-visible bytes by call,
call count, wall time, and correctness; cache-read and total-token figures remain
secondary diagnostics.

### 2. One Explicit Workflow Router

`SKILL.md` replaces “Start Every Task” discovery with one ordered router. The
first matching path wins:

| Intent | Primary path | Review path |
| --- | --- | --- |
| Read a known target | bounded `show` | none |
| Discover or exactly count targets | bounded `find` | none |
| Create or patch one resource | its exact porcelain command | preview only when the command or user requires it |
| Create one new view-backed owner and items | compact `add --input -` | direct non-destructive settlement |
| Configure an existing owner's view | `view set TARGET MODE` | preview only when impact requires it |
| Inspect persisted view state | `view inspect TARGET` | none |
| Submit a known non-destructive dependent ChangeSet | `commit --input -` | no Diff artifact |
| Change or remove existing structure, or resolve ambiguity/high impact | `diff --input --output`, then exact `apply` | mandatory |
| Purge, merge, replace, bulk text transform, or another destructive classification | exact reviewed Diff | mandatory acknowledgement |
| Import external data | the existing inspect/plan/apply/verify workflow | mandatory import evidence |

This routing is authoritative:

- **FR-1:** Root help is never a startup step. Use it only when the command
  family is genuinely unknown or the installed CLI capability is uncertain.
- **FR-2:** `references/commands.md` is never read by the Agent at runtime.
  Cross-family selection uses the concise Skill router and, only when genuinely
  unresolved, one Bash invocation of executable root or family help.
- **FR-3:** Command help or `outline schema COMMAND` is called through Bash only
  when the concise Skill route does not cover a required property, a typed
  validation error identifies a contract gap, or version/capability evidence is
  genuinely needed. Query only that exact command schema; never request
  aggregate `ChangeSet` merely to confirm a table or lifecycle leaf.
- **FR-4:** A repeated help, schema, or unchanged-state read in one workflow is a
  Skill violation unless the preceding result was truncated and the next
  request uses its explicit continuation. Bundled references and fixtures are
  not runtime discovery inputs.
- **FR-5:** Ordinary Outline output is consumed directly. The Skill must not use
  file tools, Python, Node, `jq`, `sed`, `grep`, or a shell program to discover
  schema, generate bindings, assemble routine ChangeSets, or summarize a
  successful CLI result. Bash is transport for the `outline` executable and
  literal stdin only, not a second document-processing layer. The `command`
  argument contains only the direct `outline` invocation; JSON belongs in the
  Bash tool's separate `stdin` argument. Heredocs, shell quoting, pipelines,
  command substitutions, and temporary input files are not accepted transports.

The exact-help recovery path remains important. A validation failure may reveal
that the Skill's concise route is stale; the model calls the one exact command
schema through `outline`, corrects the input once, and returns to the primary
path. It does not launch an open-ended schema investigation.

### 3. Consumed Bash Stdin Interface

[PR #596](https://github.com/relixiaobo/lin-outliner/pull/596) is the sole design
and implementation authority for Bash stdin transport, effective-consumer
classification, constrained-Agent policy, stream settlement, and its focused
security tests. This feature relies only on the merged observable interface:

- Bash accepts one bounded `stdin: string` beside `command` and delivers its
  exact UTF-8 bytes directly to child stdin.
- Direct `outline add --input -`, `outline commit --input -`, and `outline diff
  --input -` invocations are the registered data consumers this feature uses;
  their existing `outline.edit`, `outline.edit`, and `outline.read` actions come
  from the parsed command while document payload text remains opaque. Other
  stdin consumers remain outside this feature's dependency contract.
- Executable and unknown stdin consumers fail closed in constrained Agents;
  user blocks continue to apply through the shared consumer classification.
- Input-bearing calls are foreground-only and create no temporary input file,
  argv payload, shell quoting layer, or background-input lifecycle.

The Outline Skill's representative invocation after #596 merges is:

```json
{
  "command": "outline --human add --input -",
  "stdin": "{\"kind\":\"viewed-tree\",\"placement\":{...},\"title\":\"Prices\",...}"
}
```

No helper executable or shell syntax appears around `outline`. This plan tests
the merged interface with real Outline input and capability actions end to end,
but it does not restate or edit the foundation's generic contract.

### 4. Direct Commit Is The Normal Non-destructive ChangeSet Path

The public `outline commit --input FILE|-` command already accepts one canonical
non-destructive ChangeSet and settles it atomically without a reviewed Diff.
The Skill and `references/changesets.md` must reflect that existing authority.

- **FR-6:** A known non-destructive ChangeSet uses one `commit`, not `diff`
  followed by `apply`.
- **FR-7:** `diff` plus exact `apply` remains mandatory when the intent changes
  or removes existing user content, target identity is not already proven, the
  selection is broad or surprising, the user requested review, or the Runtime
  classifies any change as destructive.
- **FR-8:** The reviewed path always asks `outline diff --output PATH` to write
  the complete immutable Diff, then passes that path directly to `outline
  apply`. The model reviews the bounded CLI receipt and prior target evidence;
  it never opens the complete normalized Diff or uses a file tool to extract
  hashes, counts, warnings, or bindings already present in the receipt.
- **FR-9:** Unknown settlement is never retried blindly. The Skill inspects
  `log` by idempotency key or Operation ID before another write.

Moving to Trash is recoverable but can still be review-bound. A conversion that
creates a table and trashes the source hierarchy therefore uses one generic
ChangeSet and exact Diff review, even if the Runtime does not classify Trash as
permanent destruction. A request that only creates a new table below an exact
parent uses the compact `add --input` form directly.

### 5. Compact View-backed `add --input`

A table is not an Outline resource. It is one ordinary owner Node whose view
configuration has `mode: table`; its rows are ordinary direct child Nodes and
its cells are field values. The compact command must preserve that model rather
than add a `table` family or table identity.

Extend the existing public `add --input` porcelain with a second, mode-neutral
structured form for one complete view-backed owner. `add` already owns creation
of one complete typed Node tree below a placement. The new form lets that same
resource boundary declare its reusable fields, direct items, field values, and
initial view without exposing the generic ChangeSet binding graph.

`buildPorcelainRequest` validates the input, resolves reused definitions, lowers
it to one ordinary public ChangeSet, and submits that ChangeSet through the
existing atomic mutation path. Existing `AddInputSchema` input remains valid;
this is a discriminated union, not an interpretation of arbitrary Node drafts.

The structured input names local fields once and works for every public view
mode:

```ts
interface ViewedTreeAddInput {
  readonly kind: 'viewed-tree';
  readonly placement: ExactDestinationPlacement;
  readonly title: string;
  readonly description?: string;
  readonly fields?: readonly LocalFieldInput[];
  readonly items: readonly ViewedItemInput[];
  readonly view: KeyedViewCreateInput;
  readonly bind?: BindingName;
}

type LocalFieldInput =
  | {
      readonly key: FieldKey;
      readonly name: string;
      readonly config: FieldDefinitionConfig;
    }
  | {
      readonly key: FieldKey;
      readonly field: OneTargetRef;
    };

interface ViewedItemInput {
  readonly content: string;
  readonly description?: string;
  readonly values?: FieldValueMap;
  readonly children?: readonly NodeDraft[];
}

type FieldValueMap = { readonly [fieldKey: string]: FieldCompatibleValue };

type KeyedViewField = ViewSystemField | { readonly fieldKey: FieldKey };

interface KeyedViewCreateInput {
  readonly mode: 'list' | 'table' | 'cards' | 'calendar';
  readonly toolbar?: boolean;
  readonly group?: KeyedViewField | null;
  readonly sort?: readonly {
    readonly field: KeyedViewField;
    readonly direction?: 'asc' | 'desc';
  }[];
  readonly filters?: readonly {
    readonly field: KeyedViewField;
    readonly operator?: ViewFilterOperator;
    readonly values?: readonly string[];
    readonly valueLogic?: 'all' | 'any';
  }[];
  readonly display?: readonly {
    readonly field: KeyedViewField;
    readonly visible?: boolean;
    readonly width?: number;
    readonly label?: string | null;
    readonly placement?: ViewDisplayPlacement;
  }[];
}
```

The names above may align mechanically with the final Source PR-I schemas, but
the behavioral contract is fixed:

- **FR-10:** Local field keys match the existing binding-name grammar, are
  unique, and identify either one new reusable field definition or one existing
  exact field definition. They are the only local references used by item
  values and view configuration.
- **FR-11:** Item `content` remains the ordinary child Node's content and maps to
  `sys:name` in view configuration. Field values use the same typed scalar
  contract and validation as public field porcelain. Missing values are omitted;
  unknown field keys fail before mutation.
- **FR-12:** `KeyedViewCreateInput` preserves the existing complete
  `ViewCreateSpecification` semantics. It adds only local field-key references;
  system fields retain their canonical `sys:*` names. Display array order is
  preserved, and omitted group/sort/filter/display properties keep their
  existing defaults.
- **FR-13:** The form accepts at most 256 local fields and 10,000 direct items,
  rejects duplicate keys and conflicting create/reuse forms, resolves every
  existing field and placement to exactly one live target, and produces no
  partial write on any failure.
- **FR-14:** Lowering creates or resolves definitions, creates one ordinary owner
  with one direct ordinary content Node per item, writes field-backed values,
  and installs one complete view configuration in a single ChangeSet and
  Operation. The CLI generates all internal IDs/bindings and requests only the
  compact returned owner identity needed by its receipt.
- **FR-15:** The same lowering supports `list`, `table`, `cards`, and `calendar`.
  It contains no table-only Node type, table identifier, row entity, or column
  storage. “Row” and “column” are Table View presentation terms only.
- **FR-16:** `add` remains create-only and non-destructive by construction. The
  viewed-tree form cannot update, move, trash, replace, merge, or purge a
  pre-existing Node. Converting existing structure remains the generic reviewed
  ChangeSet path.

The developer-only fixture becomes `fixtures/table-view-add.json`. It exercises
the compact mode-neutral input with `view.mode: table`, two reusable fields, two
ordinary child items, one sort rule, and explicit display metadata in tests. It
is not linked as an Agent runtime instruction and is never read by the model.
The old generic `table-view-changeset.json` is removed so the test and
documentation surface cannot preserve the verbose per-row binding topology.

### 6. Public `view inspect` Verification

Add `view inspect TARGET` to the existing `view` family as the bounded read
companion for every view mode. It uses existing public projection and
exact-count authority internally and returns a compact
`outline.view-summary`; it does not add a Runtime storage or mutation route.

`runner.ts` intercepts this CLI-composed command before generic Runtime dispatch,
resolves one exact owner, and issues only existing `show` and `find` requests.
The Runtime never receives a `view inspect` command and gains no handler. Every
component read must report one consistent revision; a revision race retries the
bounded composition once and then returns an explicit retryable conflict rather
than combining observations from different revisions.

The result contains:

```ts
interface ViewSummary {
  readonly kind: 'outline.view-summary';
  readonly revision: number;
  readonly ownerId: string;
  readonly title: string;
  readonly mode: 'list' | 'table' | 'cards' | 'calendar';
  readonly toolbarVisible: boolean;
  readonly itemCount: number;
  readonly displayFieldCount: number;
  readonly displayDigest: string;
  readonly displayFields: readonly {
    readonly fieldId: string;
    readonly label: string;
    readonly visible: boolean;
    readonly order: number;
  }[];
  readonly group: string | null;
  readonly sortCount: number;
  readonly filterCount: number;
}
```

- **FR-17:** The target resolves exactly once and must own exactly one live
  `viewDef`; otherwise inspection fails without writing. The result reports the
  persisted mode instead of assuming that the requested mode was applied.
- **FR-18:** `itemCount` is exact and counts direct ordinary content children
  only. It excludes the view definition, protected Source entry, field entries,
  field values, and other structural children introduced by the final Source
  model.
- **FR-19:** Display metadata follows the view's complete display configuration
  and resolves labels deterministically. The digest covers the complete ordered
  display state so bounded human output can prove whether an omitted tail
  changed.
- **FR-20:** Inspection performs any local pagination/count composition behind
  one CLI invocation. It never returns row cell contents, complete owner
  descendants, or unrelated document state.

This command gives the Skill independent final-state evidence without asking the
model to parse a large generic `show` Projection. For a table request, success
requires `mode: table` plus the expected ordinary item and display-field counts;
the summary never invents a separate table resource.

### 7. Deterministic Human Receipts

Non-interactive CLI execution currently defaults to a JSON envelope, and most
`--human` commands still pretty-print the complete JSON result. Through `bash`,
that JSON becomes a string inside another tool-result envelope, adding escaping
without helping the model decide what happened.

`--json` remains the complete stable machine contract. `--human` becomes a
deterministic presentation contract for model-visible execution:

- **FR-21:** Operation receipts contain command, applied/no-change status,
  Operation ID when present, revision transition, affected count and digest,
  recovery state, idempotency identity when available, and a bounded list of
  returned root IDs. They never print complete returned projections or every
  affected ID.
- **FR-22:** The viewed-tree `add` receipt additionally prints owner ID, item
  count, display-field count, and persisted view mode. `view inspect` prints the
  complete summary when it fits and otherwise prints the counts, display digest,
  a bounded display-field prefix, and the exact omitted count.
- **FR-23:** `diff --output FILE` in human mode writes the unchanged exact Diff
  artifact and prints a review receipt: artifact path/bytes/hash, Diff and
  ChangeSet hashes, base revision, affected counts by effect, destructive
  classifications, bindings, warning codes/messages, and explicit omission
  counts. The Skill must stop or narrow the work when any review-critical tail
  is omitted; it must not silently apply from a partial receipt.
- **FR-24:** Every human receipt is valid UTF-8, stable across TTY/non-TTY use,
  free of ANSI control sequences, and capped at 4 KiB. A cap is expressed with
  counts and digests, never silent truncation.
- **FR-25:** Failure output keeps the existing typed error code, message, and
  recovery guidance. Validation failures name the exact command schema to read;
  they do not suggest aggregate schema exploration.

The presentation implementation belongs to `src/outline/cli/runner.ts` or a
small adjacent pure presenter module. It does not use or modify the generic
Agent shell projector. Raw `--json` responses, Diff artifacts, Operation log
records, and Runtime protocol results remain byte-for-byte governed by their
existing schemas.

The Skill uses `--human` whenever stdout is intended for the current model. It
uses `--json` only when a test explicitly validates the JSON contract. Exact
Diff artifacts travel directly from `outline diff --output PATH` to `outline
apply --input PATH`; neither the model nor a file tool opens or echoes them.

### 8. Skill And Reference Rewrite

The Outline Skill remains a concise router, not a copy of the complete command
registry. Mandatory runtime guidance is self-contained in `SKILL.md` or
discoverable from the executable; file-backed resources are developer and
packaging artifacts, not a second runtime instruction path:

- `SKILL.md` owns invariant routing, safety, verification, Table View semantics,
  one minimal viewed-tree stdin skeleton, and the prohibition on file-tool or ad
  hoc schema/ChangeSet scripting.
- `references/commands.md` remains generated from the capability registry and is
  the exhaustive developer-visible inventory; the Agent uses executable help
  and schema instead of reading this file.
- `references/changesets.md` owns the direct-commit versus reviewed-Diff
  documentation for maintainers; every mandatory decision and recovery rule is
  also present in `SKILL.md` or executable help.
- `fixtures/table-view-add.json` is test-only golden input whose view mode is
  `table`; it is not an Agent resource dependency.
- `references/import.md` remains maintainer documentation and import fixtures
  remain test-only. The Agent does not read either at runtime; mandatory import
  routing and safety stay in `SKILL.md` and executable command help.

The Skill must say explicitly:

1. load inline once through the `skill` tool and preserve the user's exact task;
2. inspect only state required to prove target and cardinality;
3. select the primary path from the router;
4. use Bash only to execute `outline`, with literal structured input supplied by
   the separate Bash `stdin` argument to `--input -`, never command quoting,
   heredoc, pipeline, helper process, or a file tool;
5. run one mutation command;
6. preserve the compact Operation/no-change receipt; and
7. verify consequential work with one narrow independent `outline` read.

No invocation arguments may rewrite these rules. The Skill frontmatter declares
no execution override, shell command, allowed-tools list, model, or effort. The
existing inline invocation and argument-authority tests remain the governing
execution boundary.

### 9. Safety, Correctness, And Recovery

- **NFR-1:** One accepted viewed-tree `add` produces exactly one Operation and one
  contiguous document revision. A validation or lowering failure produces no
  definitions, owner, rows, fields, or view fragments.
- **NFR-2:** A repeated request with the same idempotency key converges to the
  settled result. Unknown settlement requires `log`; the Skill never invents a
  replacement key and retries.
- **NFR-3:** Existing destructive acknowledgement, Diff hash, ChangeSet hash,
  target cardinality, causation, permission, audit, and recovery semantics do
  not change.
- **NFR-4:** Human presentation failure degrades to a bounded typed receipt or
  explicit presentation error after the canonical result is retained. It never
  changes mutation settlement and never turns a successful write into an
  uncertain retry condition.
- **NFR-5:** The compact viewed-tree `add` input and `ViewSummary` result are
  final public CLI contracts, generated into `commands.md`, exposed by
  `outline schema add` and `outline schema view inspect`, and included in
  capability-digest parity.
- **NFR-6:** `view inspect` is a CLI-composed read over existing public
  `show`/`find` requests. Runtime routing, storage, and mutation code remain
  byte-for-byte unchanged, and cross-request revision drift never produces a
  mixed summary.
- **NFR-7:** Source PR-I's ordinary-Node constructor, protected Source entry,
  Source mutation restrictions, and retired special-Node rules remain intact in
  every lowered row and owner. No pre-Source draft shape survives in fixtures or
  tests.

### 10. Dependency And Collision Boundary

Two independent foundations must merge before implementation begins:

1. the independently planned Bash stdin transport in
   [PR #596](https://github.com/relixiaobo/lin-outliner/pull/596); and
2. Source PR-I from `outline-source-resource-unification`.

Source PR-I owns the final Node draft, field/value, Source, ChangeSet, CLI
schema, constructor, and fixture baseline that this feature must consume. The
Bash interface PR #596 owns the generic tool schema, effective-consumer security
classification, process stdin delivery, and focused transport tests. Neither
foundation depends on the other, so they may be developed independently, but
this feature consumes only their merged contracts. It rebases onto `origin/main`
after both land, regenerates its work queue from actual `rg` hits and failing
tests, and removes every superseded table fixture assumption rather than
preserving compatibility. Source PR-F is visual-only and is not a dependency.

The collision self-check found no other open PR claim at plan time. The future
Source PR-I is a deliberate hard dependency and likely overlaps
`src/outline/contract/schemas.ts`, `src/outline/contract/porcelain.ts`,
`src/outline/contract/capabilities.ts`, `src/outline/cli/porcelain.ts`,
`src/outline/cli/runner.ts`, generated command references, fixtures, and CLI
tests. Those files are not edited in parallel. PR #596 is a second deliberate
dependency under generic Agent capability/process code, but it claims no
Outline file. Its merged commit is prerequisite evidence, not part of this
feature's diff. The merged host-composition plan does not overlap after generic
Agent projection, file tools, Subagent behavior, and usage UI are removed from
this scope.

### 11. Implementation Boundary

Expected implementation ownership after Source PR-I:

- `src/outline/contract/porcelain.ts` for the viewed-tree `add` input union and
  exact `view inspect` help;
- `src/outline/contract/capabilities.ts` for the `view inspect` capability;
- `src/outline/contract/schemas.ts` only for the public `ViewSummary` result and
  shared final field/view schema reuse;
- `src/outline/cli/porcelain.ts` for deterministic viewed-tree lowering;
- `src/outline/cli/runner.ts` plus at most one adjacent pure presenter/inspector
  module for view inspection and bounded human receipts;
- `src/main/builtInSkills/outline/SKILL.md` and
  `references/changesets.md` for the workflow correction;
- generated `references/commands.md` through
  `renderOutlineCommandReference`, never hand editing;
- replacement `fixtures/table-view-add.json` and removal of the verbose generic
  table ChangeSet fixture;
- `docs/spec/commands.md`, `docs/spec/agent-skills.md`,
  `docs/spec/agent-tool-design.md`, and `docs/spec/outliner-parity-matrix.md` for
  the shipped current behavior; and
- `tests/core/outlineCli.test.ts`, `tests/core/outlineCliGoldenFlows.test.ts`,
  `tests/core/outlinePorcelain.test.ts`, and
  `tests/core/outlineCommandReference.test.ts`, plus only the existing
  Outline-specific block in `tests/core/agentSkills.test.ts`.

This feature does not touch `src/core/commands.ts`, `src/core/types.ts`, generic
Agent runtime/context files, `src/outline/runtime/**`, renderer files, another
built-in Skill, `package.json`, `bun.lock`, `.github/workflows/**`,
`docs/TASKS.md`, or `CHANGELOG.md`. The only shared test-file exception is the
existing Outline-specific block in `tests/core/agentSkills.test.ts`; no generic
Skill behavior may change. The merged Bash stdin dependency does not add its
generic Agent files to this allow-list. If that interface is absent or if
implementation proves another Runtime, Core, or generic Agent change is
required rather than CLI lowering over the final Source contract, stop and
return that interface decision to PM review instead of expanding this PR.

## Open questions

There are no unresolved product questions in this plan. Ratification accepts the
mode-neutral viewed-tree `add` form, compact `view inspect`, direct-commit routing,
and 4 KiB human-receipt contract together. Exact private type names may align with
Source PR-I during implementation without changing those observable behaviors.

## Acceptance criteria

### Contract And Lowering

- [ ] **AC-1:** `outline schema add` exposes the discriminated viewed-tree form; no
  caller-generated Node IDs, field-entry IDs, view IDs, or binding graph is
  required.
- [ ] **AC-2:** `outline add --input` lowers new and reused fields, ordinary child items,
  typed values, and complete list/table/cards/calendar view state into one valid
  final-Source ChangeSet.
- [ ] **AC-3:** Unknown keys, duplicate fields, mismatched field values,
  unresolved definitions, excessive bounds, and invalid placements fail before
  mutation.
- [ ] **AC-4:** One successful create produces one Operation, one revision transition, a
  real `viewMode: table`, correct fields/cells, exact row count, and exact revert.
- [ ] **AC-5:** `view inspect` rejects owners without one exact view and returns owner
  identity, persisted mode, exact item count, display count/digest, and complete
  view summary without item payloads. A transport trace proves that the CLI
  issued only existing `show`/`find` Runtime requests at one consistent revision
  and that no `view inspect` Runtime request or handler exists.

### Routing And Safety

- [ ] **AC-6:** The Skill selects porcelain before generic ChangeSet, `commit` before
  `diff/apply` for known non-destructive work, and exact review for destructive,
  ambiguous, existing-content conversion, or user-review-bound work.
- [ ] **AC-7:** A pure new-table fixture performs zero `diff` and `apply` calls; a separate
  existing-content conversion fixture still writes one exact Diff artifact,
  reviews its bounded receipt, and applies that artifact once.
- [ ] **AC-8:** Unknown settlement performs `log` recovery and no blind repeat.
- [ ] **AC-9:** The Outline Skill remains inline, declares no execution override, and one
  invocation cannot alter its routing or safety rules through arguments.
- [ ] **AC-10:** From Outline Skill load through final document verification,
  representative and adversarial traces contain only the `skill` tool and Bash
  calls whose executable is `outline`. They contain zero `file_*` calls, UI
  automation, direct Runtime calls, storage access, Python, Node, `jq`, `sed`,
  `grep`, or helper shell programs.

### Context Efficiency

- [ ] **AC-11:** The sanitized prepared-table trace uses one Skill load, zero or
  one bounded human `show/find`, one human `add --input -`, and one human `view
  inspect`; the exact-destination case uses three Provider tool calls. The Bash
  call's `command` contains only the direct `outline` invocation and its
  separate `stdin` field contains the complete structured input.
- [ ] **AC-12:** That trace uses zero root help, zero aggregate `ChangeSet` schema reads,
  zero reference or fixture reads, zero input-artifact writes, zero ad hoc
  scripts, zero full Diff/Operation reads, and zero generic full-table `show`
  projections.
- [ ] **AC-13:** One valid 10,000-row viewed-tree payload larger than macOS
  `ARG_MAX` reaches the real CLI through the merged Bash stdin field, produces
  the correct table, and leaves the shell argv free of payload bytes. Human
  mutation, Diff, and view receipts remain at or below 4 KiB and expose explicit
  omitted counts/digests at the boundary.
- [ ] **AC-14:** `--json` golden responses and exact Diff artifacts retain their complete
  public schemas; `--human` output contains no nested JSON envelope or ANSI
  control sequences.
- [ ] **AC-15:** Before/after evidence records Provider Call count, per-call model-visible
  bytes, uncached input, cache read, output, wall time, and correctness. It does
  not use `totalTokens` alone as the conclusion.

### Repository Gates

- [ ] **AC-16:** Regenerate and verify the command guide with
  `bun scripts/generate-outline-command-reference.ts --check`.
- [ ] **AC-17:** Run focused `outlineCli`, `outlineCliGoldenFlows`,
  `outlinePorcelain`, `outlineCommandReference`, and the Outline-specific
  `agentSkills` tests.
- [ ] **AC-18:** Run `bun run typecheck`, `bun run test:core`, and `bun run docs:check`.
- [ ] **AC-19:** Run `git diff --check` and residue searches proving the retired verbose
  table fixture and mandatory Direct-ChangeSet `diff/apply` guidance are gone.
- [ ] **AC-20:** An executable diff-path allow-list permits product code changes
  only in `src/outline/contract/porcelain.ts`,
  `src/outline/contract/capabilities.ts`,
  `src/outline/contract/schemas.ts`, `src/outline/cli/porcelain.ts`,
  `src/outline/cli/runner.ts`, at most one new adjacent pure CLI module declared
  in the PR body before implementation, and
  `src/main/builtInSkills/outline/**`. Specs and tests are limited to the exact
  files named in the implementation boundary, with shared documentation and
  `agentSkills` edits confined to their Outline-specific sections. Any diff
  under `src/main/agent/**`, `src/outline/runtime/**`, `src/renderer/**`, another
  built-in Skill, Core protocol files, dependency manifests, workflows, or
  main-owned board/changelog files fails the gate.
