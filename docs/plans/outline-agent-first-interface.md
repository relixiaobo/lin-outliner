# Outline Agent-first Interface

## Goal

Make the public `outline` CLI the smallest reliable semantic interface between
an Agent's intent and the persisted Tenon document. An Agent should describe the
state it wants, while the CLI owns schema resolution, identity, composition,
atomicity, verification, bounded evidence, and recovery. Routine work must not
require the Agent to reconstruct Core storage, inspect intermediate IDs, parse
large schemas, or recover through trial and error.

This plan is **one complete feature delivered in one PR**. It replaces the
public Outline Agent interface end to end: creation, reads, edits,
relationships, views/searches, lifecycle, recovery, and specialized workflows
all adopt one coherent model before the replacement ships. The build order
below is internal dependency order, not a sequence of partial releases. The PR
updates the Skill and current specification, retires every superseded public
path in the same change, and passes realistic Agent task acceptance.

The clean-slate answer is also the selected target. Existing CLI names and
input shapes are resolvable pre-release constraints, not product requirements.
Core's event-sourced document model, atomic command boundary, security model,
and one-document authority remain hard constraints; current porcelain topology
does not.

Objectives:

- **OBJ-1:** A routine exact-target task completes with one CLI call after Skill
  load, including persisted-state verification and recovery identity.
- **OBJ-2:** A task that genuinely needs discovery completes with one bounded
  read followed by one write, without intermediate mutation lookup.
- **OBJ-3:** Public input uses one documented author vocabulary and one representation
  for each concept across simple arguments, structured input, advanced
  transactions, help, examples, schemas, and results.
- **OBJ-4:** Outline, Table, Cards, and Calendar remain views over the same Node
  data. No Agent-facing command invents a table, row, card, or calendar-event
  persistence model.
- **OBJ-5:** Progressive disclosure makes the common path immediately
  executable while keeping uncommon and advanced capabilities complete.

## Non-goals

- Do not redesign the renderer or introduce a second document store, table
  engine, record type, query database, or Agent-private mutation API.
- Do not expose Core commands, storage nodes, binding topology, config Nodes,
  view-definition children, or socket/IPC details as Agent responsibilities.
- Do not optimize call count by weakening target proof, atomicity, write
  authorization, destructive review, data integrity, or recoverability.
- Do not make one universal command with an unbounded union schema. A small
  coherent command system and intent-specific structured variants remain
  progressively discoverable.
- Do not encode weather, tables, or another observed example as a special case.
- Do not preserve deprecated CLI spellings or dual-read compatibility. Tenon is
  pre-release; each replacement is a clean cut with its recipes, tests, Skill,
  and specification changed atomically.
- Do not change `src/core/commands.ts` or `src/core/types.ts` unless a later
  execution unit proves the canonical data model itself is insufficient. Such
  a discovery stops that unit and requires a shared-interface-first claim.
- Do not combine unrelated command families into one oversized implementation
  PR merely because they share this design authority.

## Design

### 1. Decision, evidence, and constraints

- **EVD-1:** The first weather-table trace required schema discovery and input
  repair before success. PR #617 reduced the prepared happy path to one add and
  one inspect but did not change the authoring semantics.
- **EVD-2:** The repeated trace still required approximately twelve Provider
  calls because the Agent guessed a natural field type rejected by the CLI, then
  had to discover and manually reuse existing global field IDs.
- **CON-1 hard:** All persisted mutation remains event-sourced and crosses the
  Core command boundary atomically. Security, causation, permissions, and exact
  destructive review cannot regress.
- **CON-2 hard:** One canonical document owns user data. Views, searches, CLI
  receipts, and Agent history cannot become alternate truth stores.
- **CON-3 resolvable:** Current CLI commands, Core-token vocabulary, and Skill
  instructions are pre-release interface choices and may be replaced cleanly.
- **CON-4 unknown:** Automatic committed-state verification and binding-based
  composition must prove bounded cost at the existing 10,000-child limit.
- **ASM-1:** One owner or saved Search has one active persisted View
  configuration. Multiple named Views over one scope are not current product
  behavior and remain outside this plan.

Options considered:

- **OPT-1 patch current porcelain:** add aliases, compatible field ensure, and
  better errors to `viewed-tree`. Rejected because it preserves an internal
  resource shape and addresses only the observed task.
- **OPT-2 add one command per presentation:** add table/outline/cards/calendar
  creation commands. Rejected because presentation modes would become false
  data types with duplicated semantics.
- **OPT-3 selected clean-slate interface:** expose the canonical logical model
  through a small intent-shaped CLI, keep Views mode-neutral, and move all
  deterministic composition and verification behind the command boundary.
- **TRD-1:** Clean cuts create short-term branch churn, accepted because aliases
  would permanently enlarge Agent discovery and preserve contradictory terms.

### 2. Product model and invariants

The interface starts from the document model, not from current CLI commands.

#### Node data

A **Node** is the single structural and content identity. Nodes form an ordered
tree. A Node owns rich text, description and ordinary metadata, may reference
other Nodes, and may hold typed field values. A direct child shown as a table
row or a card remains that same Node when presentation changes.

A **Field definition** is a reusable typed property definition. A **field
value** belongs to a Node and points to one field definition. A request-local
field key is only an authoring alias that connects declarations, Node values,
and View configuration inside one input; it never becomes a second persisted
identity.

A **reference** is an explicit relationship to an existing Node. Inline and
tree-reference presentation do not duplicate the target's content identity.

#### Views

A **View** is persisted projection configuration over a scope of Nodes. Its
public modes are `outline`, `table`, `cards`, and `calendar`. The current Core
`list` token may remain an internal representation but is not the public product
term.

Every Node scope has an effective View. When no explicit configuration is
stored, its effective mode is `outline`; the presence or absence of an internal
view-definition Node is an encoding detail. Setting another mode and returning
to Outline both edit the same logical View.

- Outline projects hierarchy and optionally selected fields.
- Table projects the same Nodes as rows and fields/system properties as columns.
- Cards project the same Nodes and selected fields into card regions.
- Calendar projects the same Nodes through a selected date field.

A view may define display fields, grouping, sorting, filtering, toolbar state,
and mode-specific required roles. Switching modes changes only View
configuration. It never converts, copies, reparents, or rewrites the scoped
Nodes or their field values. A Table request is satisfied only when the
persisted View mode is table; it does not create a `table` resource.

A normal owner scopes its direct ordinary children. A saved Search supplies a
query-derived scope and owns View configuration over its results. Search
materialization is an implementation concern, not an alternate source of Node
truth.

#### Operations

An **Operation** is the durable atomic settlement and recovery unit. One
complete user intent creates at most one Operation. A rejected request creates
none. A success receipt is derived from committed state, not merely from a
dispatched command or candidate projection.

These invariants become explicit public specification and test authorities.
Any future semantic command must lower to this model rather than add a parallel
resource abstraction.

**FR-1:** Every public command and result preserves this logical model regardless
of its current physical encoding. Internal field-entry or view-definition Nodes
remain storage details. A new public resource kind requires a distinct durable
identity and lifecycle, not merely a different renderer.

### 3. One semantic authoring shape

Replace `add`, the `kind: viewed-tree` alternative, and task-specific table
creation with one complete-resource `outline create` interface. Its structured
input separates data, reusable property definitions, and optional presentation:

```json
{
  "at": { "parent": "@today", "position": "first" },
  "fields": [
    { "key": "weather", "name": "Weather", "type": "text" },
    { "key": "low", "name": "Night low (C)", "type": "number" },
    { "key": "high", "name": "Day high (C)", "type": "number" }
  ],
  "node": {
    "text": "Chengdu district weather",
    "description": "Sunny throughout.",
    "children": [
      {
        "text": "Central districts",
        "fields": { "weather": "Sunny", "low": 21, "high": 32 }
      }
    ]
  },
  "view": {
    "mode": "table",
    "display": ["weather", "low", "high"]
  }
}
```

The same shape creates a plain Node, a nested Outline, or one owner shown as any
view mode. `fields` is optional; `view` is optional; neither changes the
meaning or identity of `node`. Rich content, tags, references, checkboxes,
assets, nested children, and typed field values use discriminated narrow
subschemas only when supplied.

Field declarations use compatible ensure semantics by default. The declaration
array fixes authoring and default display order and rejects duplicate local
keys before lowering. The CLI
reuses a case-insensitively same-name field definition only when all explicitly
declared constraints match its effective configuration. Omitted constraints do
not constrain reuse. An exact field locator may force identity. An incompatible
definition rejects the whole request with the existing ID and differing
properties; it is never silently changed.

Public field types are `text`, `select`, `select-from-tag`, `date`, `number`,
`url`, `email`, and `checkbox`. One boundary codec maps these to and from Core
tokens. All Agent-authored CLI inputs and public results use the public terms,
including advanced transactions. Runtime state and immutable reviewed artifact
internals remain canonical and never persist aliases.

The CLI lowers the complete request to one ChangeSet using internal bindings
and commits it once. Reviewed Diff and Operation records retain the submitted
intent hash separately from the normalized ChangeSet hash, so replay requires
both the same submitted request and the same reviewed artifact without reading
mutable current state. Internal changes and reads do not become Provider calls.

**FR-2:** Plain, nested, field-backed, and View-backed creation use this one
shape and one Operation. No mode adds another owner/item/value identity model.

### 4. Small command system organized by intent

The clean public surface has layers, not one command per UI gesture.

| Intent family | Primary commands | Responsibility |
| --- | --- | --- |
| Observe | `get`, `find`, `export`, `watch` | Exact bounded retrieval, discovery/counting, streaming/export. |
| Author data | `create`, `edit` | Complete creation and convergent desired-state patch of Node content, metadata, tags, fields, references, and optional View. |
| Organize | `move`, `duplicate` | Structural placement with exact sources/destinations and one settlement. |
| Define | `define create`, `define ensure`, `define edit` | Explicit reusable field/tag identity and configuration work. Ordinary `create`/`edit` hides this machinery. |
| Present | `view get`, `view set` | Read or declaratively replace/preserve projection configuration without changing data. No mode-specific resource commands. |
| Query | `search create`, `search edit`, `search run` | Saved or transient query scope, with optional View configuration. |
| Lifecycle | `trash`, `restore`, `purge`, `merge` | Explicit content lifecycle and identity consolidation with appropriate review. |
| Advanced | `transact`, `preview`, `apply` | Bounded cross-resource dependencies and exact destructive review. |
| Recover | `history`, `revert`, `undo`, `redo` | Durable settlement inspection and guarded reversal. |
| Specialized | `asset`, `import`, `capture` | Workflows whose byte transport, evidence, provenance, or coverage require a dedicated contract. |

Short argv forms remain for obvious scalar work. Structured input is the same
command with `--input -`; it is not a second behavior. Domain leaf commands are
retained only when they express a distinct semantic operation that cannot be a
clear desired-state field in `edit`. UI-level add/set/remove variants are
absorbed when they only expose storage choreography.

`transact` is the advanced escape hatch corresponding to today's ChangeSet
kernel. It is not the default for complete resources. The public transaction
grammar uses the same locators, values, enum vocabulary, and result model as
semantic commands, so escalation does not require relearning an internal
dialect.

The registry owns command identity, intent category, risk class, request and
result schema, examples, help, completion, permission classification,
postcondition verifier, and receipt presenter. Parser and documentation drift
is a failing generated test, not a convention.

**FR-3:** A command exists at the narrowest stable user intent, never at a UI
gesture or storage step. A complete request uses one semantic command; only a
genuine cross-resource dependency escalates to `transact`.

### 5. Desired state, identity, and convergence

Command semantics are named and consistent:

- `create` requires a new Node identity but may ensure referenced reusable
  definitions declared as dependencies.
- `ensure` reuses or creates one compatible stable identity.
- `edit` and `view set` converge on requested state; repeating the same request
  returns `no-change` and no new Operation.
- `add` and `remove` survive only for true set/list membership where repetition
  is naturally idempotent.
- `replace`, `merge`, `trash`, and `purge` declare their destructive class and
  use exact review when required.

The Agent never supplies an ID that the CLI can safely mint, looks up a newly
created ID needed only later in the same request, or chooses between create and
reuse for a compatible dependency. Exact IDs remain required when identity is
the user's intent, ambiguity would change meaning, or an existing object is the
mutation target.

Selectors share one compact public grammar. Common calls accept exact IDs and
stable aliases directly. A bounded query selector appears only in commands that
are genuinely safe and meaningful for multiple targets. Cardinality and maximum
are explicit properties of that selector, not repeated command-specific syntax.

**FR-4:** Repetition has declared semantics for every mutation: converge to
no-change, create a new requested identity, or fail before commit. No retry may
depend on guessing which behavior occurred.

### 6. Closed-loop results and recovery states

Every non-stream command returns a typed result and one deterministic summary
receipt capped independently of affected data size.

A successful mutation receipt contains:

- `Status: applied|no-change` and `Committed: true|false`;
- Operation ID and revision transition when applied;
- primary persisted target IDs and semantic counts;
- requested postconditions and `Verification: passed` from a fresh committed
  projection;
- created versus reused dependency counts when relevant;
- warnings that require user judgment;
- the exact recovery command when recovery is available.

Routine callers do not perform a second verification call. `get`, `view get`,
or `history` remain available when the user independently asks to inspect state,
when a workflow spans separately authorized steps, or when verification cannot
fit the mutation's declared postcondition contract.

A rejected mutation contains:

- `Status: rejected` and `Committed: false`;
- one stable error code and exact input path or conflicting identity;
- expected public values or requested/actual mismatch without echoing large
  input;
- whether retry is safe;
- one exact corrective command or payload edit when deterministic.

Unknown settlement never presents as ordinary rejection. It returns the
idempotency or Operation handle and the exact `history` resolution command.
Errors do not recommend full schema output when a local allowed set, narrow
variant, or conflicting object is already known.

**FR-5:** A routine successful mutation is complete when its receipt reports a
fresh committed-state postcondition pass. Rejection, unknown settlement, and
successful settlement are disjoint result states with different retry rules.

### 7. Progressive disclosure owned by Skill and registry

The disclosure ladder is fixed:

1. Skill metadata identifies when persisted Outline work is in scope.
2. `SKILL.md` provides the intent router, minimal syntax for routine one-call
   work, data/view distinction, review boundary, and stopping/recovery rules.
3. `outline example INTENT [VARIANT]` returns one validated executable shape for
   an unfamiliar common task.
4. Exact command help explains its options, defaults, convergence, risk, and
   result.
5. `outline schema COMMAND --variant NAME` or `--path JSON_POINTER` returns only
   the relevant bounded fragment for unusual structured authoring.
6. Complete named schemas and capabilities remain for integration, audit, and
   debugging, not ordinary Agent work.

The Skill does not copy exhaustive enum inventories, command manuals, storage
structure, or failure algorithms. It retains a direct form when omitting that
form causes a predictable metadata round trip. It does not tell the Agent to
preflight global definitions or independently verify a command whose typed
result already verifies its declared postconditions. Conditional details may
live in Skill references only when they change decisions; executable mechanics
remain registry-owned.

Every common recipe is byte-checked against the production request schema and
forward-tested as an Agent task. A failed common recipe is a CLI contract bug,
not a reason to enlarge `SKILL.md`. A recipe named `complete` must exercise
every public facet named by its intent: compound edits include references,
complete View configuration includes grouping, sorting, filtering, and display,
and dependent transactions demonstrate a binding consumed by a later structural
operation.

**FR-6:** Each disclosure level adds only information unavailable at the
preceding level. Ordinary passing tasks do not load lower levels preemptively.

### 8. Registry-derived workflow audit

Build the audit queue from the executable registry plus a checked-in task
corpus, never from agent memory. Each task fixture declares:

- user intent and authorized starting state;
- expected command family and maximum Provider calls;
- maximum model-visible result bytes excluding irreducible authored payload;
- expected Operation count and postconditions;
- allowed discovery level;
- retry, rejection, destructive review, and recovery behavior.

The corpus covers at least:

| Workflow | Normal call budget after Skill load |
| --- | --- |
| Exact read | one `get` |
| Exact Field-backed Node read | one `get`; no storage traversal |
| Text discovery or count | one `find` |
| Plain or nested creation | one `create` |
| Creation with fields and any View mode | one `create` |
| Repeat creation with compatible definitions | one `create` |
| Exact convergent edit | one `edit` |
| Discovery-dependent edit | one `find`, one `edit` |
| Move or duplicate | one structural command when targets are exact |
| Declarative View switch/configuration | one `view set`; Node data unchanged |
| Saved Search creation/update | one corresponding search command |
| Full-tree export | one `export`; its receipt is sufficient artifact evidence |
| Daily Note ensure | one `daily ensure`; no pre-read |
| Trash or restore | one corresponding lifecycle command |
| Bounded query edit | one matching recipe, one `edit`; no ID enumeration |
| Cross-resource dependent mutation | one `transact` |
| Destructive semantic mutation | one semantic preview, one exact invocation of the same command after review |
| Destructive advanced ChangeSet | one `preview`, one exact `apply` after review |
| Unknown settlement recovery | one exact `history` lookup; no blind retry |
| Revert | one `revert` |
| Import | inspect, preview/plan, exact apply, built-in verification |

For each registered command, generated checks prove:

- every help/example input parses;
- argv and structured forms use the same public vocabulary;
- every enum rejection lists its accepted public values;
- every mutation has a postcondition verifier and closed-loop receipt;
- result size is bounded independently of affected set size;
- create/ensure/edit semantics match their names;
- no complete-resource fixture requires intermediate-ID discovery or a shell
  loop;
- no public View mode or result implies a parallel data model;
- permission and destructive classification match actual lowered effects.

The audit output is an ephemeral report. Each real gap is either fixed in the
owning execution unit or becomes a separate claim-sized plan. Completion is an
empty unexplained-violation set.

**NFR-1:** Provider calls, model-visible bytes, Operation count, and committed
postconditions are executable budgets in the corpus, not review-time estimates.

### 9. Clean cut and compatibility

This is a public CLI replacement before release, not a compatibility layer.
When an execution unit lands, it removes the commands, aliases, schema variants,
fixtures, help, Skill text, and specs it supersedes. Errors for removed commands
name the new command only during the development cycle if that improves local
diagnosis; no legacy parser remains.

The Core document format does not change merely because public vocabulary and
composition improve. Public codecs translate at the CLI/Runtime boundary.
Development userData is reset only if a later unit changes persisted canonical
state, following the repository's pre-release policy.

### 10. Internal build order

#### Step A: Complete-resource creation

Deliver `outline create`, the unified Node/field/View input, compatible field
ensure, public vocabulary codec, committed-state postcondition verification,
closed-loop receipts, concise Skill route, and fresh/repeated multi-view golden
tasks. Remove `add` and `kind: viewed-tree`. This step directly replaces the
weather trace with one mutation call after Skill load.

Expected files include Outline contract schemas/registry/recipes, CLI lowering
and presentation, Runtime compatible ensure, built-in Outline Skill, focused
Core tests, and current command/Agent Skill specifications. It must not require
Core protocol changes.

#### Step B: Exact observation and assertions

Deliver coherent `get` and `find` contracts, shared selectors/projections,
narrow result assertions, bounded summaries, and continuation. Absorb `show`
and standalone `view inspect` behavior where `get` projections or assertions
express the same intent. Exact Node reads project reusable Field identity,
public type, typed values, and inheritance on the owning Node instead of making
the Agent traverse storage field entries. Keep export/watch specialized. Update
read recipes and prove exact read and discovery budgets.

#### Step C: Convergent editing

Deliver one `edit` desired-state contract for content, description, metadata,
tags, typed fields, references, and optional View patching. Absorb current
`set`, `done`, routine tag/field/source leaves, and other storage-level gestures
that do not represent distinct domain actions. Preserve dedicated commands for
semantic transformations whose consequences require separate review. Prove
repeat no-change, bounded bulk, and discovery-dependent flows.

#### Step D: Structure, relationships, and lifecycle

Normalize move, duplicate, reference transformation, merge, Trash, restore,
purge, and text transformation around one placement grammar, explicit identity
effects, and consistent preview/apply rules. Each command returns verified
postconditions and exact recovery. Retire redundant UI-shaped variants.

#### Step E: Definitions, views, and queries

Deliver explicit definition create/ensure/edit, mode-neutral View get/set, and
saved/transient Search contracts over the canonical model. Public `outline`
mode maps to internal `list` without changing scoped Nodes. View mode switches
prove data-identity preservation across all four modes. Ordinary Node create/edit
continues to hide reusable-definition mechanics.

#### Step F: Advanced and specialized workflows

Align transact/preview/apply, history/recovery, assets, capture, import, and
watch with the same vocabulary, result, verification, and progressive-disclosure
contract. Preserve specialized multi-step flows only where authorization,
external bytes, coverage evidence, or destructive review makes the steps
semantically necessary. Remove the final stale Skill/manual paths and close the
registry audit.

These steps land together. Foundation precedes consumers inside the branch:
the product model, vocabulary codec, registry, result contract, and verification
kernel settle before individual command families and Skill routing consume
them. No step is merged, published, or presented as complete independently.

### 11. Risks and controls

- **Semantic over-consolidation:** a universal edit union could become harder to
  author than leaf commands. Keep one common object shape with discriminated
  optional sections and retain a leaf only when it represents a distinct domain
  operation proven by task corpus.
- **Data/view conflation:** task-shaped convenience may accidentally persist
  table concepts. Golden tests create once, switch across all View modes, and
  assert unchanged Node and field identities/values.
- **Hidden verification cost:** automatic verification could re-read large
  state. Each command declares minimal postconditions and uses count/digest/
  identity projections rather than payload-sized reads.
- **Boundary vocabulary drift:** one codec owns every public ingress/egress;
  registry tests reject Core tokens in Agent-authored schemas and public
  projections.
- **Large tree lowering:** internal operation count and committed verification
  must remain bounded. The existing 10,000-child case remains a performance and
  atomicity gate.
- **Destructive convenience:** fewer calls must not collapse preview and apply
  where review is meaningful. Risk classification is registry-owned and tested
  against lowered effects.
- **Migration churn:** a clean cut can disrupt concurrent branches. The Draft
  PR claims the complete command/spec surface before implementation, and the
  branch stays internally consistent at every pushed review point even though
  only the final state is mergeable.

### 12. Collision result

The claim was checked against `origin/main`, `docs/TASKS.md`, and open PRs on
2026-09-02. The only open claim is PR #618, which owns Agent execution-selection
settings and does not overlap Outline files. The board states that the public
Outline CLI and built-in Skill lanes are clear. Result: **no overlap**.

## Acceptance criteria

### System contract

- [ ] **AC-1 (OBJ-4):** One canonical Node/property data set can switch among
  `outline`, `table`, `cards`, and `calendar` without changing Node, field
  definition, field value, reference, or scope identity.
- [ ] **AC-2 (OBJ-3):** All Agent-authored CLI inputs and public outputs use one
  author vocabulary; Core-only tokens are absent from the public corpus.
- [ ] **AC-3 (OBJ-5):** A common task uses Skill guidance directly; an unfamiliar
  common task needs at most one recipe; exact help and narrow schema are later
  fallbacks; full schema is never required by a passing task fixture.
- [ ] **AC-4:** Every registered mutation declares convergence, risk,
  postconditions, receipt, recovery, and permission behavior, with no
  unexplained registry-audit violations.

### Creation gate

- [ ] **AC-5 (OBJ-1):** Fresh and repeated weather-style creation each use one
  `outline create --input -` call after Skill load, commit one Operation, and
  return `Verification: passed` without `example`, help, schema, find, or a
  second verification call.
- [ ] **AC-6:** Repeated creation reuses compatible field definitions exactly,
  creates a new requested owner/subtree, and creates no duplicate definitions.
- [ ] **AC-7:** An incompatible same-name field rejects with `Committed: false`,
  its exact ID and mismatches, and one corrective action; state and Operation
  count remain unchanged.
- [ ] **AC-8:** A successful create receipt contains root identity, semantic
  Node/property/View counts, created/reused dependencies, committed verification,
  Operation/revision identity, warnings, and exact recovery within the summary
  byte budget.
- [ ] **AC-9:** Plain tree creation and all four View modes use the same create
  schema and lowering; there is no table/row/card/event resource or `viewed-tree`
  discriminator.
- [ ] **AC-10:** The 10,000-child structured-stdin case remains atomic and within
  an explicitly measured size/time budget; receipt size does not scale with
  child count.

### Delivery verification

- [ ] **AC-11:** The feature removes all superseded commands and updates the
  registry, recipes, Skill, current specs, and golden corpus in the same PR.
- [ ] **AC-12:** Help/example/parser/schema/completion/result drift guards derive
  their work queue from registry artifacts and pass with no unexplained hits.
- [ ] **AC-13:** Every implementation PR runs `bun run typecheck`, focused tests,
  `bun run test:core`, and `bun run docs:check`; relevant renderer/E2E tests are
  added only when that unit changes their behavior.

## Open questions

None.
