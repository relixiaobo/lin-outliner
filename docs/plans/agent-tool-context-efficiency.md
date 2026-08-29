# Agent Tool Context Efficiency And Loop Control

## Goal

Make model-visible tool history useful, bounded, and semantically consistent
across local files, shell commands, web tools, Agent controls, MCP tools, and the
public Outline CLI. A later tool result must not lose its useful observation
because an earlier result consumed a shared budget, and `bash` must not retain
more model context merely because it uses a different Item representation.

Reduce avoidable Provider Calls caused by repeated actions whose observable
state has not changed. Frame externally supplied web content as untrusted data
without treating it as host instructions. Make ordinary usage surfaces explain
the difference between uncached input, cache activity, output, and billed cost.

This plan is a **set of four complete features**, each delivered in one PR:

1. semantic tool-result projection;
2. tool-loop and untrusted-result hygiene;
3. Outline workflow context efficiency; and
4. usage and context-composition observability.

The delivery graph contains three real ordering edges:

- PR A and PR B may start independently from current `main`.
- PR A establishes the specialized `agent` projector seam consumed later by
  `agent-result-and-file-lifecycle`; that plan remains the sole owner of
  delegated-result settlement semantics.
- Source PR-I from `outline-source-resource-unification` must merge before PR C
  consumes the final public Outline CLI, ChangeSet, constructor, and fixture
  contracts.
- PR D follows PR A and PR B because its accepted context-composition evidence
  measures their final projection and repetition behavior.

Each unit is independently usable when it lands; an ordering edge names a final
contract dependency or evidence baseline, not a partial scaffold.

## Non-goals

- Do not rewrite, summarize, normalize, or reconstruct provider-authored tool
  arguments to save tokens. The frozen provider name and exact arguments remain
  canonical model-call history.
- Do not discard, truncate, or replace canonical raw tool output retained by an
  Item or its `outputRef`. Model projection and durable evidence remain distinct.
- Do not change tool permission, capability, admission, causation, secret
  redaction, worktree, or write-boundary semantics.
- Do not change model context-window, output-reservation, Goal, Subagent, or
  safety-budget accounting. PR A adds a projection-allocation bound inside the
  existing input plan; product safety limits and billing presentation remain
  separate concerns.
- Do not prohibit shell or Python generally. The system removes the context
  incentive to misuse them; shell remains valid when it is the correct tool.
- Do not add a document-native Agent tool, scenario-specific Runtime route, or
  private Outline API. Persisted document access remains `bash` plus the public
  `outline` CLI.
- Do not make the built-in Outline Skill isolated. Isolation would add a child
  Turn and result boundary without solving command selection or output size.
- Do not change the public Outline CLI contract in this plan. PR C starts only
  after Source PR-I lands that contract's final Source-aware shape.
- Do not add migration, dual-read, or compatibility code for pre-release Agent
  payloads. PR A's structured projection payload uses the repository's clean-cut
  userData reset policy.
- Do not infer successful task completion from lower token use. Correctness,
  preserved observations, and independent verification remain mandatory.

## Evidence Baseline

The development history audit that motivated this plan covered 180 Turns:

| Tool | Calls | Argument bytes | Raw output bytes | Provider projection bytes |
| --- | ---: | ---: | ---: | ---: |
| `web_fetch` | 941 | 99,704 | 8,516,848 | 5,539,727 |
| `file_read` | 16 | 2,281 | 424,901 | 39,525 |
| `bash` | 51 | 15,140 | 295,264 | 295,927 |
| `file_write` | 4 | 141,036 | 728 | 728 |
| `file_grep` | 1 | 362 | 81 | 81 |

`file_glob` and `file_edit` had no representative production sample, so their
acceptance evidence must come from deterministic fixtures rather than an
unsupported empirical claim.

One measured Turn made 33 Provider Calls. Its estimated input grew from 101,511
to 146,515 tokens; the Turn recorded 78,578 uncached-input tokens, 4,192,768
cache-read tokens, 12,004 output tokens, and USD 2.8494 total cost. Within that
same Turn:

- `bash` projections added about 20,401 estimated tokens;
- `web_fetch` projections added about 16,929 estimated tokens;
- one `file_write` call carried about 23 KiB of exact arguments and added 5,787
  tokens to the next request;
- one 76,689-byte `file_read` output added only 87 tokens because its useful
  content had fallen back to status-only evidence; and
- two later Outline commands still added about 5,792 and 5,835 tokens each.

This baseline establishes two separate causes. Result projection is unfair by
Item type, and repeated Provider Calls repeatedly resend an already large
cacheable prefix. The implementation must measure both instead of using total
token count as a proxy for either one.

## Design

### 1. Semantic Tool-Result Projection

#### 1.1 Three layers, one durable result authority

Every completed tool Item has three deliberately different representations:

1. the complete durable result and `outputRef`, retained for audit, UI detail,
   artifact retrieval, fork, and recovery;
2. one deterministic, bounded **frozen semantic observation**, derived once
   from that completed result; and
3. one ephemeral **Provider-boundary rendering** of the frozen observation,
   sized fairly beside every other reachable result in the active Turn.

The frozen observation is the sole model-projection source. It is not
reconstructed from renderer fields, does not consult mutable tool state, and
never modifies the call's exact arguments. A restart, fork, compaction, or
provider change loads and verifies the same semantic source. Boundary rendering
may monotonically reduce optional excerpts as more results enter the active
Turn, but it can never remove or rewrite the frozen semantic core.

The clean payload shape is structured rather than a text convention:

```ts
interface FrozenSemanticToolObservation {
  readonly core: readonly SemanticToolResultSegment[];
  readonly optional: readonly OptionalToolResultSegment[];
}

interface SemanticToolResultSegment {
  readonly kind: 'identity' | 'outcome' | 'bounds' | 'continuation' | 'recovery';
  readonly text: string;
}

interface OptionalToolResultSegment {
  readonly kind: 'content' | 'head' | 'tail' | 'hit' | 'patch';
  readonly ordinal: number;
  readonly text: string;
}
```

The concrete protocol may use equivalent names, but it preserves this exact
separation. Core segments contain only identity, semantic outcome,
bounds/truncation, continuation, and necessary recovery. Their complete
serialized rendering is capped at 128 estimated tokens per result. Optional
segments retain ordered excerpts up to the per-result class cap below. Owners
must use stable compact fields rather than moving arbitrary body text into the
core to escape allocation.

PR A owns the coordinated clean cut from `full | inline` selection to the final
structured semantic payload, its codec, current producers, projection,
compaction dependencies, fork/restart behavior, and residue guard. No legacy
decoder, dual payload, text-marker parser, or automatic userData conversion is
added; pre-release verification uses a documented clean dev userData reset.

Existing integrity rules remain: a missing or conflicting frozen observation
degrades the whole call and result pair to bounded typed evidence, never an
orphan result or a fatal Turn. Image artifacts remain separate ordered image
content with their existing identity and geometry markers.

#### 1.2 Remove FIFO starvation without unbounding the active Turn

`freezePendingToolOutputProjections` stops assigning raw-full visibility from a
Turn-wide first-come budget. Freezing one result is a pure function of:

- the frozen completed Item;
- its canonical tool identity and result shape;
- its immutable output references; and
- the tool class's fixed semantic-source cap.

Frozen per-result caps are centralized and measured in estimated model tokens:

| Result class | Maximum frozen observation | Required semantic core |
| --- | ---: | --- |
| File/page content and fetched readable content | 4,096 tokens | identity, outcome, bounds/truncation, continuation/recovery |
| Search/glob result sets | 2,048 tokens | identity, outcome, result bound, truncation/recovery |
| Shell and generic textual tools | 2,048 tokens | identity, outcome, omitted size, artifact/recovery |
| Mutations and control tools | 1,024 tokens | identity, outcome, changed-target bound, recovery |
| Unknown extension or MCP result | 2,048 tokens | identity, outcome, omissions, retained artifacts |

These caps bound the immutable source; they are not independent entitlements in
the next Provider request. At every Provider boundary, after canonical
projection and before final context planning, one fair allocator performs a
second pass over all reachable active-Turn tool results:

1. Render every result core and no optional segments.
2. Read the existing `inputTokenLimit`, which already excludes provider framing
   and the output reserve. Measure stable prompt, tool schemas, exact call
   arguments, assistant history, active user/application evidence, and their
   message framing as mandatory non-result content. Measure result-message
   framing, non-reducible images, and every result core as the complete core sum.
3. Let `availableForResults` be `inputTokenLimit` minus stable prompt, schemas,
   and mandatory protected non-result content. Set the aggregate active-Turn
   result budget to the smaller of `availableForResults` and the larger of the
   complete core sum or 25% of `inputTokenLimit`.
4. If the complete core sum itself does not fit, throw the existing explicit
   `ContextCapacityError`: no result excerpt can be reduced further, and exact
   arguments or other mandatory active-Turn content must never be rewritten.
5. Allocate the remaining optional budget with deterministic max-min fairness.
   Give every unsatisfied result an equal share, redistribute unused shares
   until no budget or demand remains, and assign indivisible remainder units by
   canonical Item order only after equal shares are settled.
6. Ask each owner projector to render its optional segments within that grant.
   The owner preserves line/JSON/UTF-8/content-part boundaries and its declared
   head/tail or ordered-hit semantics.
7. Run the ordinary context planner. Historical Turns may compact normally;
   the protected active Turn now already fits whenever its mandatory core-only
   form fits.

The 25% figure therefore remains an aggregate optional-content ceiling rather
than a FIFO raw-output prize. A pathological number of results may consume more
than that share only through their mandatory 128-token cores, and even then the
whole protected Turn remains bounded by `availableForResults`. Result-heavy
sequential or parallel execution cannot turn the next request into an avoidable
capacity failure; an unavoidable failure must be attributable to core plus
exact non-result content, not optional excerpts.

Adding a later result can shrink earlier optional excerpts, but all results keep
their cores and receive equal opportunity for optional content. The allocation
depends on the reachable observation set, demands, and model input limit, not on
which large result arrived first. Context Reset still clears the projection
epoch and allocator state; it does not replenish a privileged full-output queue.

#### 1.3 Tool-owned semantic projectors

A small projection registry maps canonical built-in tool identities to pure
projectors and reserves explicit slots for domain-specialized contributors. It
is an output concern only; it is not a second tool registry and does not
participate in exposure, admission, argument validation, permissions, or
execution. The projection owner receives only the frozen Item/result shape and
a budget, not ambient Host authority.

Built-in projectors provide these contracts:

- `file_read`: keep path, content kind, requested and returned line/page range,
  exact observed text, `hasMore`, `lineTruncated`, warnings, and the next
  continuation coordinate. Text truncation is line-aware and preserves a
  contiguous observed range rather than unrelated head/tail fragments.
- `file_grep`: keep searched path/pattern, ordered matches through the cap,
  result bound, truncation, and guidance to narrow the search. Do not replace
  all hits with success status.
- `file_glob`: keep ordered paths through the cap, search root/pattern, bound,
  and truncation. Default and hard limits remain execution limits rather than a
  promise that every path enters model history.
- `file_write`, `file_edit`, and `file_delete`: keep path, structured patch or
  affected targets, semantic no-change, warnings, and recovery guidance. Do not
  echo full write content already present in exact call arguments.
- `web_fetch`: keep source/final URL, status and content metadata, a bounded
  readable excerpt, truncation, and a readable retained-artifact handle when
  more content exists.
- `bash`: keep exit/interruption/background state, bounded output head and tail,
  omitted byte count, and the existing readable output artifact handle. Never
  use `commandExecution.aggregatedOutput` as an unbounded inline fallback.
- `agent_message` and `task_stop`: keep target identity, delivered/terminal
  state, and meaningful recovery without duplicating exact argument text.
- Outline commands remain `bash` calls and follow the same shell projection;
  no Outline-specific private exception enters the projector.

An unknown extension or MCP tool uses the generic projector. It preserves
ordered text and image/artifact identity, bounds text with head/tail omission,
and never falls back to status-only solely because its Item type is dynamic.
Reserved domain-specialized result kinds do not use this fallback.

Projector absence or failure is an inspection-only runtime condition. Record a
bounded diagnostic and use the generic projector; do not fail the completed
tool, the Item, or the Turn. A missing required specialized contribution is a
structural assembly error while its owning tool is exposed; unavailable
historical specialization degrades that exchange to typed evidence rather than
silently applying generic semantics.

#### 1.4 One specialized Agent-result seam

PR A defines one `SpecializedToolResultProjector` contribution point for the
canonical `agent` result and its `collabAgentToolCall` Item. The contribution
returns the same structured core/optional segments consumed by the fair
allocator, but the generic projector never decides what child text, generation,
references, settlement state, or fallback belongs in those segments.

The current collaboration owner contributes an adapter that preserves current
foreground/background result semantics through this seam, so PR A is complete
and behavior-preserving when it lands. It adds no delegated-result cap,
citation selection, transcript path, delivery retry, or settlement rule.

After PR A, `agent-result-and-file-lifecycle` consumes the same contribution
point with its ratified `SubagentHandoffProjector`. That projector remains the
sole owner of:

- foreground `agent` result and background-notification settlement;
- explicit-generation carry-forward and settlement continuations;
- terminal child text plus selected file-reference allocation;
- parent-visible coverage and exact transcript fallback; and
- foreground reservation and pending background delivery when settlement does
  not yet fit.

The generic fair allocator supplies only the Provider-boundary total grant and
max-min allocation mechanics. It does not reinterpret the specialized
projector's core, choose references, expose paths, or create a second transcript
resolver. The lifecycle implementation replaces the preserving adapter at the
same owner seam rather than replacing PR A's generic projection mechanism.

#### 1.5 File observation and mutation consistency

`file_read` must not authorize an edit using bytes the model never observed.
The local-file implementation records a candidate frozen observation but grants
no mutation authority from that candidate alone. When a Provider-boundary plan
successfully renders the observation, projection reports the exact contiguous
file range actually included. `WorkspaceContext.readFileState` records that
delivered coverage plus source freshness metadata. A failed capacity plan or an
optional excerpt that received no allocation grants no read coverage.

`file_edit` may use a fresh partial observation only when the exact
`old_string` is wholly contained in one delivered contiguous range. Execution
still reads the current file, checks the recorded freshness, enforces unique
occurrence or `replace_all`, and applies the normal write boundary.
`file_write` overwriting an existing file continues to require delivered
coverage of the complete file because it replaces content outside any local
edit fragment. A truncated single line is not complete observation of that
line, and disjoint excerpts cannot be concatenated into invented contiguous
coverage.

The unchanged-read shortcut is valid only when the earlier observation remains
reachable with content in the latest successful Provider-boundary rendering.
If fair allocation removed its optional text, or compaction, reset, or
dependency degradation removed it, `file_read` returns a new bounded candidate
observation of the requested content instead of instructing the model to use
unavailable earlier text. Context Reset and compaction clear delivered coverage
that their restored observation checkpoint does not explicitly retain.

#### 1.6 Projection lifecycle and measurement

The implementation adds a sanitized trace fixture derived from the measured
33-call Turn. It contains large `file_read`, `web_fetch`, `bash`, file mutation,
Agent-control, and unknown dynamic results without user content, credentials,
host paths, or provider payloads.

The fixture runner reports for every Provider Call:

- total estimated input;
- stable prompt and tool-schema contribution;
- exact tool-call argument contribution;
- projected result contribution by canonical tool;
- aggregate result budget, core sum, optional demand, and each fair-share grant;
- maximum and cumulative projection bytes; and
- whether a semantic field or continuation marker was lost.

The matrix also generates many maximum-size sequential observations and one
maximum-size parallel batch against the smallest context window in the current
supported-model catalog. Their arguments and non-result content are sized so
the core-only active Turn is admissible. The next Provider Call must then fit,
every result must retain its complete semantic core, optional grants must obey
max-min fairness, and no dynamic result may collapse to status-only evidence.
A companion case deliberately makes exact arguments plus cores exceed capacity
and verifies the unchanged explicit `ContextCapacityError` rather than argument
rewriting or core loss.

It is a deterministic regression fixture, not a benchmark tied to one machine.
Raw development telemetry and absolute userData paths never enter the repo.

### 2. Tool-Loop And Untrusted-Result Hygiene

This PR absorbs both remaining `agent-hygiene-checks` items from the task board:
untrusted framing for web results and the repeated-behavior notice.

#### 2.1 Typed untrusted web observations

`web_fetch` owner output marks fetched page text, response bodies, extracted
metadata, and remote error bodies as `untrusted/observation` before canonical
projection. Host-authored status, truncation, artifact, and recovery fields
remain application evidence outside that boundary.

The boundary is represented structurally and rendered by the canonical context
projector. It is not detected by scanning fetched text for words such as
"instruction" and cannot be forged by literal user or page content. The model
is told once, in the bounded wrapper, to treat the enclosed bytes as data rather
than system or user instructions. The wrapper does not suppress or rewrite the
page content.

Existing Subagent-output scanning remains independently owned. This PR shares
the authority vocabulary and wrapper semantics where appropriate, but does not
route web results through `scanSubagentOutput` or make one domain's marker parser
the other's authority.

#### 2.2 Conservative semantic repetition detection

The runtime tracks eligible completed tool actions within one Turn. A repetition
fingerprint contains:

- canonical tool identity;
- a tool-owner supplied semantic action key derived from validated execution
  arguments; and
- a tool-owner supplied semantic outcome key derived from stable result fields.

Exact provider arguments remain frozen and replayed unchanged. Keys are hashes
used only for Turn-local comparison and diagnostics; they are never arguments,
permissions, product identity, or persisted result authority.

Only read-only, idempotent, or control tools with an explicit owner classifier
are eligible. Initial coverage includes identical `web_fetch` failures and
unchanged responses, duplicate `agent_message` delivery to the same Agent
generation, redundant `task_stop` against the same terminal task, and repeated
unchanged file reads. File writes, document mutations, shell commands, unknown
extensions, and MCP tools are ineligible by default. A new tool is not covered
until its owner defines stable action and outcome semantics.

After the same eligible action produces the same semantic outcome twice without
intervening state change, the second result receives one bounded host-authored
nudge. The nudge states that the repeated action returned no new information and
asks the model to change strategy or finish. Further identical repetitions do
not append more notices. Execution is not blocked, the native result is not
reclassified as failure, and the structured details remain exact.

User steering, a changed semantic outcome, a changed action key, a new Agent
generation, or a new Turn resets the relevant sequence. Provider transport
retries do not count because they did not settle another tool execution.
Parallel calls in one batch are compared only after their own outcomes settle;
ordering cannot make an unrelated sibling look repetitive.

Diagnostics record eligible fingerprint identity, occurrence count, and whether
the one nudge was emitted. They do not persist raw arguments or result bodies a
second time.

#### 2.3 No polling protocol

The existing Agent catalog remains authoritative: background completion is
delivered automatically, `agent_message` is for new steering, and `task_stop` is
for interruption. The nudge reinforces those existing semantics only after
observed repetition. Do not add a timer, polling loop, status endpoint, hidden
Subagent message, or second collaboration state machine.

### 3. Outline Workflow Context Efficiency

The built-in Outline Skill remains an inline, non-isolated Skill. This PR changes
its executable guidance and fixtures only; Runtime, CLI, permissions, and public
schemas remain unchanged.

PR C begins only after Source PR-I from
`outline-source-resource-unification` merges. Source PR-I owns the final
Source-aware CLI/ChangeSet schemas, dedicated Source commands, ordinary-Node
constructor invariants, special image/attachment Node retirement, and
schema-checked fixture baseline. PR C regenerates its fixture/guidance work queue
from that merged authority; it does not preserve, document, or optimize the
superseded pre-Source command surface. Source PR-F is visual-only and is not a
dependency.

#### 3.1 Fixture-first contract

`SKILL.md` and `references/changesets.md` define two explicit authoring paths:

1. **Covered fixture path.** When the requested structure is represented by a
   bundled fixture, adapt that fixture directly. Do not first run root help,
   `outline schema ChangeSet`, `outline diff --help`, or `outline apply --help`.
2. **Discovery path.** Read only the command-specific help or schema needed when
   no fixture covers a required field, a validation error identifies a contract
   gap, or the CLI version/capability is genuinely uncertain.

Table View uses the covered path. The table fixture remains the executable
source for owner, reusable fields, rows, values, bindings, view configuration,
and returned projection. A table request must not invoke Python, Node, or an ad
hoc shell program to rediscover those shapes.

Fixture adaptation may change literal values, selectors, row counts, field
counts, grouping, sorting, filters, and display fields already demonstrated by
the fixture. If the request needs an operation or view leaf absent from the
fixture, query only that exact schema portion and then return to the fixture
topology. Never dump a multi-megabyte aggregate schema into context to confirm a
single leaf.

#### 3.2 Minimal read, preview, apply, and verification results

Every ChangeSet fixture and documented workflow requests only the return
Projection needed for immediate review and verification:

- preview: Diff identity, base revision, warnings, affected count, destructive
  classification, targets, and returned bindings;
- apply: Operation ID, status, affected count, warnings, recovery state, and
  requested bindings;
- verification: the exact created/changed root with only the required children,
  fields, and view leaves.

Large Diff artifacts remain files passed to exact `apply`; they are not echoed
through a second shell command. `show` and `find` stay bounded and are not used
to re-read complete document state after a targeted mutation.

#### 3.3 Skill acceptance fixtures

Skill tests freeze the following behavioral instructions:

- a normal Table View task selects the bundled fixture before schema/help;
- schema/help is conditional recovery, not a mandatory authoring ritual;
- ordinary Outline transformations do not create ad hoc Python/Node scripts;
- preview and apply remain exact and atomic;
- successful dispatch still requires bounded independent verification; and
- isolation is absent from the Outline Skill frontmatter.

The tests verify guidance and fixture shape. They do not assert a brittle full
natural-language transcript from one model.

### 4. Usage And Context-Composition Observability

#### 4.1 Separate billing facts in ordinary UI

The ordinary Turn hover/detail surface stops presenting only `totalTokens`.
Using the canonical `Turn.execution.usage`, it shows:

- uncached input;
- cache read;
- cache write;
- output; and
- total USD cost when available.

`totalTokens` remains available in detailed diagnostics and for existing safety
accounting, but the ordinary label must not imply that cached and uncached
tokens have the same billing or latency meaning. All labels are localized, use
the existing number/currency formatting, fit the current compact hover surface,
and expose the same facts to assistive technology.

No estimated token count is presented as a provider-billed fact. Missing cache
or cost data is omitted rather than synthesized.

#### 4.2 Derive context composition from existing diagnostics

Turn Diagnostics already retain the exact prepared system prompt, canonical
tool schemas, ordered canonical messages, content-part provenance, and actual
provider usage. Main derives, for each Provider Call, an inspection-only context
composition with these categories:

- stable prompt;
- tool schemas;
- application context/evidence;
- user input;
- assistant prose/history;
- exact tool-call arguments;
- projected tool results; and
- image observations.

The derivation uses canonical message structure plus typed provenance; it never
parses labels from text. It reports exact serialized bytes and explicitly
labelled estimated tokens. Actual provider usage remains a separate record.
Categories sum to the prepared canonical context estimate under one documented
estimator, while provider adapter framing and post-adapter payload overhead stay
visible as an unassigned delta rather than being misattributed.

The existing diagnostics payload is sufficient authority. Prefer a main-owned
derived Trajectory projection over adding duplicate persisted fields. If a
message fragment or diagnostics dependency is missing, omit the affected
composition row and expose typed unavailability; inspection failure never fails
the Turn.

#### 4.3 Compare calls, not just Turn totals

Trajectory exposes per-call deltas so an investigator can distinguish:

- one large exact `file_write` argument;
- one large projected `web_fetch` or shell result;
- repeated resending of an unchanged cacheable prefix; and
- genuinely new user or application context.

The sanitized 33-call fixture verifies the categorization and provides the
before/after evidence for PR A and PR B. This UI does not prescribe a token target
or change runtime behavior.

## Delivery Units

### PR A — Semantic tool-result projection

Scope:

- `src/main/agent/context/ToolOutputProjection.ts`
- `src/main/agent/context/ContextProjector.ts`
- `src/main/agent/context/ContextBudgetPlanner.ts`
- `src/main/agent/capabilities/agentLocalTools.ts`
- the web and MCP result adapters that produce canonical model observations
- the current Agent collaboration owner only to contribute its preserving
  specialized projector adapter
- local output-normalization helpers under `src/main/agent/runtime/`
- `src/core/agent/protocol.ts` and `src/core/agent/codec.ts` for the final
  structured semantic projection payload
- `docs/spec/agent-model-runtime.md`
- `docs/spec/agent-tool-design.md`
- focused Core tests and sanitized trace fixtures

Complete outcome: all generic textual tool history uses structured frozen
semantic observations plus one fair active-Turn aggregate allocation; no FIFO
starvation, unbounded optional-result sum, or `bash` fallback exception remains;
file observation and mutation authorization agree with delivered bytes. The
specialized `agent` seam is complete with its preserving owner adapter and ready
for the lifecycle plan without defining that plan's settlement semantics.

PR A is the coordinated owner for this final Agent-internal payload/codec cut and
all current consumers. It lands the shared shape and complete usable mechanism
in one PR, then uses the pre-release clean-reset policy. No later unit in this
plan changes that payload contract. Any additional shared interface discovered
during implementation is a stop-and-coordinate condition rather than a
drive-by extension.

### PR B — Tool-loop and untrusted-result hygiene

Scope:

- tool-owner repetition classifiers in the existing capability owners
- `src/main/agent/runtime/kernel/` execution-loop integration
- web-result context authority and projection
- Turn Diagnostics activity/projection only if the existing activity fields
  cannot represent the notice without ambiguity
- `docs/spec/agent-model-runtime.md`
- `docs/spec/agent-tool-design.md`
- `docs/spec/agent-integration.md`
- focused kernel, web, Agent-control, and injection tests

Complete outcome: the two remaining `agent-hygiene-checks` subjects are fully
implemented and no separate fast-track remains. Because untrusted-data framing
touches an injection boundary, the main gate adds security review.

### PR C — Outline workflow context efficiency

Dependency: Source PR-I must be merged on `main`; Source PR-F is not required.

Scope:

- `src/main/builtInSkills/outline/SKILL.md`
- `src/main/builtInSkills/outline/references/changesets.md`
- covered fixtures under `src/main/builtInSkills/outline/fixtures/`
- generated Skill-reference guards if fixture links or generated command docs
  require synchronization
- `tests/core/agentSkills.test.ts` and focused built-in-Skill tests
- `docs/spec/agent-skills.md` when the current-behavior contract changes

Complete outcome: fixture-covered table work has no mandatory schema/help phase,
uses no ad hoc script, requests bounded returns, and verifies real Table View
state through the final Source-aware public CLI.

### PR D — Usage and context-composition observability

Delivery ordering: PR A and PR B must be merged so this PR measures and presents
their final projection-allocation and repetition evidence rather than a
superseded baseline.

Scope:

- `src/main/agent/thread/ThreadTrajectoryProjection.ts`
- existing Agent trajectory DTO/codec files only where a derived composition
  field requires them
- `src/renderer/agent/components/ThreadView.tsx`
- Trajectory detail components and Agent i18n catalogs
- `docs/spec/agent-model-runtime.md`
- `docs/spec/agent-thread-rendering.md`
- Core projection, renderer, i18n, and accessibility tests

Complete outcome: ordinary usage separates cache and uncached facts, and
Trajectory attributes prepared context to stable semantic categories without
adding another persisted authority.

## Acceptance Criteria

### Semantic projection

1. Reordering a fixture's completed tool Items does not change any individual
   frozen semantic observation.
2. A large early `web_fetch`, `bash`, or unknown dynamic result cannot reduce a
   later `file_read` or `file_grep` to status-only evidence.
3. Every reachable active-Turn result retains its complete 128-token-or-smaller
   semantic core at every successful Provider boundary.
4. Optional grants use deterministic max-min fairness and never depend on FIFO
   arrival priority; unused shares redistribute without exceeding demand.
5. Aggregate rendered active-Turn results do not exceed the computed fair result
   budget, and mandatory protected context plus rendered results remains within
   the existing model input limit.
6. Many maximum-size sequential observations on the smallest supported context
   window still produce a fitting next Provider Call with every core present.
7. One maximum-size parallel batch on that window satisfies the same fit, core,
   and fairness properties regardless of settlement order.
8. When exact arguments, result cores, and other mandatory protected content
   alone exceed capacity, planning returns the existing explicit
   `ContextCapacityError`; it does not rewrite arguments, drop cores, or retry
   the Provider with misleading evidence.
9. Every frozen observation fits its class cap including metadata and omission
   markers; Unicode, JSON, line, and content-part boundaries remain valid.
10. `file_read` projection always identifies the exact delivered range and the
   next action when more content exists.
11. A fresh partial file observation authorizes `file_edit` only when the exact
   `old_string` lies wholly inside that observed range; stale, absent, or
   truncated observations fail before writing.
12. Overwriting an existing file with `file_write` still requires a fresh
   complete observation.
13. The unchanged-read shortcut replays content when its earlier observation is
   no longer model-reachable.
14. `bash` retains bounded head/tail, omitted byte count, and artifact access but
   never replays the complete `aggregatedOutput` through fallback.
15. Complete raw output, structured details, artifacts, UI detail, fork, and
   recovery remain unchanged by model projection.
16. Exact provider-visible tool name and arguments are byte-equivalent before
    and after this feature, including arguments stored in payloads.
17. Missing, corrupt, or conflicting projection evidence degrades only the
    affected exchange and does not kill the Turn.
18. The sanitized trace fixture shows no semantic-field loss and a lower total
    projected-result contribution than the recorded baseline; the report keeps
    exact arguments separate rather than crediting projection for argument cost.
19. The canonical `agent`/`collabAgentToolCall` path is never handled by the
    generic projector. Its current owner adapter preserves existing behavior,
    and the specialized seam accepts the lifecycle plan's
    `SubagentHandoffProjector` without changing generic allocation.

### Loop and untrusted-result hygiene

20. The second identical eligible action/outcome pair emits exactly one bounded
    nudge; the third and later pairs emit no additional nudge.
21. A changed action, changed result, user steering, new Turn, or new Agent
    generation does not inherit a stale repetition sequence.
22. Mutations, shell calls, unknown extensions, and MCP calls are not classified
    as repetitive without an explicit owner policy.
23. Provider retries and parallel sibling calls do not increment a settled-tool
    repetition count incorrectly.
24. Repetition detection never blocks execution, changes success/failure, or
    mutates canonical arguments or structured result details.
25. Fetched page content is structurally projected as untrusted observation;
    literal wrapper-like text cannot escape or forge the authority boundary.
26. The existing Subagent-output framing behavior remains unchanged, and web
    framing does not depend on the Subagent instruction-marker parser.
27. The measured repeated-`agent_message` and repeated-web-failure fixtures
    produce fewer no-progress Provider Calls without suppressing a legitimate
    state-changing follow-up.

### Outline workflow

28. On the merged Source PR-I baseline, a Table View fixture test reaches `diff`
    without requiring root help,
    ChangeSet schema, `diff --help`, or `apply --help`.
29. Missing fixture coverage or a validation error directs the Agent to the
    smallest exact schema/help query rather than an aggregate schema dump.
30. Table guidance rejects Markdown/plain-text substitutes and ad hoc schema
    discovery scripts while preserving one atomic ChangeSet.
31. Preview, apply, and verification request only the documented minimal return
    fields and preserve Operation/recovery evidence.
32. The Outline Skill remains non-isolated and uses only the final public CLI.

### Observability

33. Ordinary Turn usage presents uncached input, cache read, cache write, output,
    and cost from canonical execution usage without conflating estimates.
34. Zero or unavailable usage components are omitted consistently and localized
    UI remains compact, keyboard accessible, and screen-reader meaningful.
35. Per-call context composition deterministically categorizes stable prompt,
    schemas, application evidence, user input, assistant history, exact tool
    arguments, projected results, and images from typed structure.
36. Category byte counts and token estimates reconcile with the canonical
    prepared-context estimate; adapter overhead remains an explicit delta.
37. Missing diagnostics or fragments degrade the inspection view and never
    affect execution, history, or Turn status.

## Verification

Each PR runs `bun run typecheck`, its focused Core/renderer suites, and
`bun run docs:check`. The implementation PRs also run `git diff --check`.

PR A additionally runs:

- `tests/core/agentToolOutputProjection.test.ts`;
- `tests/core/agentContextBudgetPlanner.test.ts` and Provider-boundary allocator
  tests for core-only admission and fair optional grants;
- local tool projection and read-before-edit tests;
- context projection, compaction, fork, and restart tests;
- shell/web/MCP output-artifact tests;
- the sanitized trace fixture plus maximum sequential and parallel matrices on
  the smallest supported context window;
- structured payload codec, clean-reset residue, and no-legacy-decoder guards;
  and
- current-preserving and lifecycle-shaped specialized `agent` projector
  contributions through the same seam.

PR B additionally runs:

- native kernel sequential and parallel execution tests;
- Agent collaboration delivery/terminal-state tests;
- web untrusted-framing and prompt-injection fixtures; and
- replay of repeated action/outcome traces with nudge counts.

PR C additionally runs the built-in Skill acceptance and generated-reference
guards and validates every changed JSON fixture against the current public
Outline schema produced by merged Source PR-I.

PR D additionally runs Core trajectory projection, diagnostics codec, renderer
Thread/Trajectory, i18n, and accessibility tests. Main visually verifies the
compact usage surface in light and dark themes. Its checked-in comparison uses
the merged PR A/PR B behavior rather than recording the pre-change baseline as
current.

Before any implementation PR is marked ready, capture its before/after trace
report in the PR body. The report must show Provider Call count, exact-argument
tokens, projected-result tokens by tool, uncached input, cache activity, output,
and cost where the provider supplied cost. A lower `totalTokens` number alone is
not acceptance evidence.

## Risks And Mitigations

- **Useful content can be over-trimmed.** Semantic projectors preserve required
  identity, bounds, continuation, and recovery before optional body content;
  real trace fixtures assert field survival, not only byte size.
- **Independent caps can overflow the protected Turn.** Per-result caps bound
  only frozen sources; the Provider-boundary allocator enforces one aggregate
  result budget and proves sequential/parallel fit on the smallest supported
  context window.
- **The mandatory core can itself become too large.** Cores have a hard
  per-result bound, optional text cannot escape into them, and an impossible
  core-plus-exact-argument Turn fails explicitly instead of lying or rewriting
  history.
- **Projection can become a second result authority.** Complete output and
  structured details stay canonical; projection is frozen observation only and
  never drives UI truth, permissions, replay arguments, or operation identity.
- **Generic projection can steal delegated-result ownership.** The canonical
  `agent` path is reserved to one specialized seam; the lifecycle plan owns
  handoff selection, references, settlement, and transcript fallback.
- **File edits can become too permissive.** Partial-read authorization requires
  exact observed containment plus current freshness and normal uniqueness/write
  checks; whole-file rewrite stays full-read-only.
- **A repetition guard can suppress legitimate work.** It does not block calls,
  is opt-in per tool owner, resets on state change or steering, and emits only
  one advisory nudge.
- **Untrusted framing can teach the model a new textual convention.** Authority
  is typed through canonical provenance; tests inject forged wrappers and keep
  them ordinary content.
- **Fixture-first guidance can drift from the CLI.** Fixtures are schema-checked
  against merged Source PR-I and remain executable. Discovery is retained as an
  explicit fallback after a real gap or validation failure.
- **Usage labels can imply billing precision the provider did not supply.** UI
  distinguishes actual usage/cost from estimates and omits absent components.
- **Trace fixtures can leak local data.** Only generated synthetic values and
  normalized paths enter the repo; raw userData and Provider payloads remain
  local.

## Collision Result

- PR #591 is plan-only and has no direct overlap with the planned implementation
  files.
- PR #593 has merged its ratified `outline-source-resource-unification` design
  into current `main`. Its human-led Source PR-I owns the final public
  CLI/ChangeSet schema, Source commands, constructor invariants, special-Node
  retirement, and schema-checked fixture baseline. PR C is blocked on PR-I and
  regenerates its work queue only after that implementation merges; Source PR-F
  is not a dependency.
- `agent-result-and-file-lifecycle` already owns the ratified
  `SubagentHandoffProjector` and every delegated-result settlement semantic. PR
  A owns the generic allocator and specialized contribution seam only. The
  lifecycle implementation depends on that seam and must not add a parallel
  result-allocation mechanism.
- The task-board item `agent-hygiene-checks` directly overlaps PR B. PR B absorbs
  its two remaining subjects; do not implement a parallel notice or web-framing
  path.
- `performance-optimization` and `interaction-jank-cleanups` concern Outliner or
  renderer interaction performance. They do not own Agent context projection;
  PR D follows merged PR A/PR B and repeats the renderer file-scope check before
  editing shared Thread surfaces.
- No `docs/TASKS.md`, `CHANGELOG.md`, `src/core/types.ts`, or
  `src/core/commands.ts` change belongs to this plan PR. Main owns board and
  changelog settlement when implementation ships.
- PR A deliberately owns one coordinated Agent-internal protocol/codec cut in
  `src/core/agent/protocol.ts` and `src/core/agent/codec.ts`. Its implementation
  claim repeats the open-PR file check and lands the final shape plus every
  current consumer together. Any additional shared interface is a
  stop-and-coordinate condition under the repository's shared-interface-first
  rule.

## Open questions

None. The implementation may tune private helper names and fixture organization
without reopening product direction, but it must preserve the four PR
boundaries, exact-argument authority, semantic projection caps, conservative
repetition eligibility, fair aggregate allocation, specialized Agent-result
ownership, Source PR-I dependency, PR D evidence ordering, non-isolated Outline
workflow, and usage vocabulary defined above.

## Implementation Checklist

### PR A

- Replace FIFO full-output selection with structured frozen observations and
  deterministic max-min Provider-boundary allocation.
- Add built-in/generic result projectors and the specialized `agent` contribution
  seam without delegated settlement semantics.
- Align file observation state with exact delivered projection coverage.
- Cover partial edit and full rewrite authorization.
- Add sanitized trace, starvation/order-invariance, active-Turn aggregate-bound,
  smallest-window sequential, and parallel-batch tests.
- Land the final payload/codec clean cut and residue guard.
- Update owning specs and record before/after projection evidence.

### PR B

- Add typed untrusted web-result provenance and wrapper rendering.
- Add owner-supplied action/outcome classifiers for eligible tools.
- Emit one advisory no-progress nudge after the second identical result.
- Cover steering, generation, parallelism, retries, and ineligible mutations.
- Fold both remaining `agent-hygiene-checks` contracts into specs.
- Run the required security review at the main gate.

### PR C

- Wait for Source PR-I to merge, then regenerate fixture and guidance work from
  its final CLI/ChangeSet authority.
- Make fixture-first and discovery-fallback paths explicit.
- Remove mandatory schema/help reads from covered ChangeSet workflows.
- Bound preview/apply/verification returns in fixtures and guidance.
- Freeze Table View, no-script, atomicity, verification, and non-isolation
  acceptance rules.

### PR D

- Start after PR A and PR B merge.
- Split ordinary usage into uncached/cache/output/cost facts.
- Derive per-call context composition from existing diagnostics.
- Expose exact bytes, labelled token estimates, and adapter delta.
- Add localized renderer, accessibility, degradation, and visual coverage.
- Compare the sanitized trace before and after PRs A and B.
