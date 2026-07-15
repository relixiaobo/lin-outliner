# Semantic Ingest Pipeline

## Goal

Make text-derived nodes mean the same thing regardless of whether the source is
an agent outline, plain-text paste, rich HTML paste, internal copy/cut, or a
large batch. A bare URL must become the same clickable link mark, a `#tag` must
be applied to the node it describes, and a field value must retain its own
metadata and ordinary descendants without bypassing field rules.

The target architecture is one semantic pipeline with intentionally different
structural adapters:

```text
raw text / HTML / structured clipboard
  -> shared inline scanner
  -> structural adapter
     (strict agent | lenient paste/HTML | search operand | trusted structured)
  -> recursive NodeDraft AST
  -> destination-aware preflight and materializer
     (normal node | existing title | direct field value | value descendant | search)
  -> yielding core batch mutation / canonical serializer
```

This plan is shape (b): a set of four complete features, each delivered in its
own PR and independently testable. The order is semantic scanner, field-aware
recursive ingest, exact subtree transfer, then bulk execution and complete
reads. A later PR may depend on an earlier contract, but no PR is an unused
scaffold.

## Non-goals

- Do not merge the strict agent outline parser and the lenient paste/HTML
  structure parser. Their indentation, error recovery, identity annotations,
  and rich-format inputs are deliberately different.
- Do not run the full ingest parser on every normal typing keystroke. Existing
  live `#`, `@`, field, and code-fence triggers remain incremental consumers of
  the shared token definitions.
- Do not revive a `reference` field type. A reference remains a value shape in
  `plain`, `options`, or `options_from_supertag` fields.
- Do not reinterpret already-structured sources such as asset filenames,
  launcher capture titles, Import Pack nodes, or direct literal core commands.
  Those producers opt into structured `NodeDraft` fields explicitly instead of
  having punctuation re-scanned.
- Do not make external plain-text clipboard interchange lossless. Tenon-to-Tenon
  transfer is lossless through a versioned structured format; plain text stays a
  readable, reversible fallback for other applications.
- Do not expand `node_edit` from its current single-node mutation boundary.
  Agents read or edit descendants by their own ids and create children with
  `node_create` with `parent_id` set to the value node id.
- Do not add migration or compatibility readers for an interim draft or
  clipboard schema. The product is pre-release; one current schema and one
  explicit clipboard version are sufficient.

## Design

### 1. Purpose, decision summary, constraints, and product invariants

The selected brownfield target is a shared lexical/semantic core with separate
structural adapters and one destination-aware materializer. A single full parser
was rejected because agent round-trip syntax and rich human paste have different
structural contracts; leaving the current token passes in place was rejected
because it preserves source-dependent meaning. The minimum acceptable outcome is
ordinary-node URL/tag parity plus field-aware recursive values; exact transfer
and cooperative bulk execution complete the system so the same drift does not
reappear at the next ingestion boundary.

Hard constraints are the core command mutation boundary, main/renderer/preload
process separation, #393's reference-as-value model, #394's direct-value
boundary, existing navigation security policy, and one undo unit per ingest.
Preserving private regexes, text-based internal cloning, and synchronous bulk
loops are legacy constraints to remove, not compatibility promises.

The following rules are authoritative across every adapter and materializer:

- **INV-1:** Semantic interpretation is source-independent. Given equivalent
  visible input and the same interpretation policy, agent create and paste
  produce equivalent `RichText`, tags, fields, checkbox state, and children.
- **INV-2:** Structure and inline semantics are separate. Structural adapters
  decide rows, depth, fields, and search operands; the scanner alone decides
  links, marks, references, tags, escapes, and protected ranges.
- **INV-3:** `fieldEntry.children` are direct stored values. A direct value's
  own descendants are ordinary nodes and never become additional field values.
- **INV-4:** Direct field values use field-aware creation, validation, option
  selection, deduplication, and deletion. Only descendants below a stored value
  use ordinary node commands.
- **INV-5:** No internal transformation uses serialize-then-parse. Duplication,
  internal clipboard transfer, and materializer staging carry structured data.
- **INV-6:** Small and large inputs have identical semantics and one undo unit.
  Size may change scheduling and transport chunking, never parsing rules.
- **INV-7:** A parser or serializer never silently truncates a subtree. Bounded
  reads expose counts and pagination; exact clone/clipboard paths traverse the
  complete selected subtree.
- **INV-8:** Search operands are literal query data unless the search grammar
  explicitly assigns another meaning. For example, `value:: #foo` searches for
  `#foo`; it does not apply a tag to a query-condition node.

PR #393 removed the standalone reference field type. PR #394 then fixed the
field-value structural boundary and established this model:

```text
fieldEntry
  direct value             field-aware value semantics
    ordinary child         normal node semantics
      nested fieldEntry    normal field semantics on that child
```

The ingest design extends that landed model; it does not replace it.

### 2. Current behavior and evidence

| Surface | Current loss | Required result |
| --- | --- | --- |
| Agent `node_create` | Markdown links work, but a bare URL remains plain text. | Bare `http://`, `https://`, and `www.` URLs outside protected ranges become link marks under the same rules as paste. |
| Agent field value | `OutlineValue` carries only text, target id, and optional annotation id. Tags, rich text, fields, checkbox state, and descendants are lost. | A field value is a recursive node draft with the same inline semantics as an ordinary node. |
| Agent field indentation | Every line below a field frame is flattened into another value. | `Field:: -> Value -> Child` parses as one direct value with one ordinary child. |
| Plain single-line paste | Native paste wins when the parsed row has no marks/children, even when it carries tags, fields, or checkbox metadata. | Any semantic delta causes structured paste; truly literal single-line text still uses native paste. |
| HTML paste | DOM structure and marks are retained, but tag/field metadata is never scanned. | Rendered HTML text passes through the same scanner; link/code marks protect their ranges. |
| Paste into a field value | Generic `create_nodes_from_tree` can create direct children under a `fieldEntry`, bypassing option pools and field-type rules. | The destination selects field-aware value commands for every direct value and normal commands below it. |
| Empty trailing row | The first-block presence check ignores metadata-only rows. | Tags, fields, checkbox state, type, or children make a draft materializable even when visible text is empty. |
| Agent `node_read` | Direct values are listed, but their child counts and descendants are invisible from the owning node. | Each value exposes bounded child summary data and remains directly readable by `valueNodeId`. |
| Agent `duplicate_id` | The source is serialized at depth 12 and 500 children per level, then parsed again. | Core clones the complete authorized subtree directly with fresh ids. |
| Internal copy/cut | Only visible labels are written as plain text; hidden descendants, rich marks, fields, tags, and exact reference shapes can be lost. | A structured clipboard envelope preserves selected root subtrees; canonical text remains the fallback. |
| Large paste/create | Parsing is fast, but synchronous metadata resolution and node creation block the renderer/main loop. | Preflight once, then materialize in bounded time slices inside one undo group. |

### 3. Shared `NodeDraft` model

Add a pure shared semantic-ingest module under `src/core/semanticIngest/`. Its
types are independent of DOM and document state so main and renderer can import
them without crossing the process seam incorrectly.

The conceptual contract is:

```ts
interface NodeDraft {
  kind: 'content' | 'reference' | 'codeBlock' | 'search';
  content: RichText;
  description?: string | null;
  tags: TagDraft[];
  fields: FieldDraft[];
  checkbox?: boolean | null;
  referenceTarget?: ReferenceTarget;
  codeLanguage?: string;
  search?: SearchDraft;
  children: NodeDraft[];
  annotationId?: NodeId;
  source?: SourceSpan;
}

interface FieldDraft {
  name: string;
  annotationId?: NodeId;
  values: NodeDraft[];
  clear: boolean;
  source?: SourceSpan;
}
```

The implementation may use narrower discriminated unions, but it must preserve
these properties:

- `content` is already semantic `RichText`; later layers never re-run regexes on
  it to rediscover links or marks.
- Every direct field value is a complete `NodeDraft`. `{ text, targetId }` is not
  an allowed lossy intermediate.
- `SourceSpan` records normalized source offsets plus line/column where
  available. HTML uses offsets in rendered block text and may also record a DOM
  path; it does not pretend to have exact raw-HTML columns.
- Agent annotation ids are accepted only by the annotated edit/read grammar and
  forbidden by create, as today. Clipboard identities describe source
  relationships but are never reused as destination node ids.
- Search data is a distinct draft variant. Query-condition field names such as
  `value`, `field`, and `tag` are not ordinary document fields.
- A trusted structured producer can construct `NodeDraft` directly and mark its
  content as already interpreted. The scanner is not an unavoidable text
  heuristic applied to all strings.

`CreateNodeTree` and `PasteRowMeta` become compatibility edges, not the semantic
center. The protocol-owner PR either replaces them with `NodeDraft` at the
create/paste command boundary or adapts them immediately at that boundary; no
consumer is allowed to invent a second recursive payload.

### 4. Inline scanner

Replace the current sequence of partially shared regex passes with one lexical
scan that returns typed tokens and source spans. `textSyntax.ts` remains the
home of small public token predicates used by live triggers, while the new
scanner composes them into a complete line interpretation.

The scanner recognizes:

- backslash escapes for grammar-significant punctuation;
- Markdown links and supported inline marks;
- bare `http://`, `https://`, and `www.` URLs, excluding surrounding/trailing
  punctuation from the link target and normalizing only `www.` to `https://`;
- inline reference markers;
- canonical tag forms, including Unicode and bracketed names, with CSS hex
  colors excluded;
- checkbox markers when enabled by the structural context;
- field separators/boundaries when enabled by the structural context.

Tokens carry half-open source ranges. Link destinations, complete Markdown link
tokens, inline code, code fences, inline references, escaped literals, and
pre-existing HTML link/code marks become protected ranges. Tags and field
boundaries are recognized only outside those ranges. Removing metadata remaps
all marks and inline-reference offsets through a shared range-edit utility; no
consumer performs its own offset arithmetic.

Context is explicit rather than inferred from call site names:

```ts
type InlineScanContext =
  | 'normal-node'
  | 'direct-field-value'
  | 'search-operand'
  | 'literal-structured';
```

`search-operand` disables implicit tags and fields while retaining the explicit
reference syntax required by query operators. `literal-structured` performs no
semantic harvesting. The normal and direct-value contexts share link, mark,
reference, tag, and escape behavior.

Single-line paste interception compares the complete parsed draft, not only
marks and children. A tag, field, checkbox, reference, URL link, node kind, or
other metadata is a semantic delta and must take the structured path. A line
containing only metadata is valid: it updates the existing target row, or
materializes an empty-content row in a pristine trailing slot.

### 5. Structural adapters

#### Strict agent adapter

Keep the existing strict rules: two spaces per level, `- ` on every non-fence
line, no tabs, explicit identity annotation policy, and precise parse failures.
It consumes scanner output and builds `NodeDraft` without reparsing inline text.

Field frames distinguish the field entry from each value frame:

```text
- Parent
  - Field::
    - Value A #tag
      - Child A.1
    - Value B
```

`Value A` and `Value B` are direct values. `Child A.1` belongs to `Value A`.
For compact syntax, `- Field:: Value A` creates an implicit value frame at the
field line, so a deeper following line is a child of that value rather than a
second value. A field with multiple values uses the expanded form.

#### Lenient paste/HTML adapter

Keep permissive list markers, tabs/two-space indentation, fenced blocks, DOM
list/table/block walking, HTML line-break splitting, and the current choice of the most
faithful clipboard representation. Malformed Markdown remains literal instead
of rejecting the paste.

Both plain/Markdown and HTML blocks finish through the same scanner. HTML marks
are passed in as protected ranges before metadata harvesting, so a `#tag` inside
an anchor or code element stays literal while an unmarked sibling `#tag` is applied.
The adapter emits the same `NodeDraft` shape as the agent adapter.

#### Search adapter

Search structure remains owned by `agentNodeToolSearch.ts` and the documented
query grammar. Operator children and operand keys select `search-operand`
context before scanning. A query such as:

```text
- STRING_MATCH
  - value:: #project
```

retains `#project` as the operand. `HAS_TAG` still receives an explicit tag or
tag-definition operand because the query operator, not the generic tag scanner,
assigns that meaning.

#### Structured adapter

Internal clipboard and core clone sources already contain `RichText`, ids,
tags, fields, and node kinds. They validate and normalize the versioned payload
but never serialize to outline text or pass visible content through token
recognition again.

### 6. End-to-end flows, failure recovery, and destination-aware materialization

Parsing does not mutate. A preflight stage receives drafts, destination, source
policy, and one document revision. It resolves every referenced node, tag and
field definition, field type, option, insertion position, and permission before
the first write. The output is an immutable materialization plan plus warnings,
node/definition counts, maximum depth, and estimated payload size.

If the revision changes before the mutation reaches the document queue,
preflight runs again inside that queue. Strict agent errors include source
line/column and recovery guidance. Lenient syntax errors stay literal, but a
destination or data-integrity violation still aborts the whole operation rather
than partially pasting.

Validation policy is also explicit. Strict agent input rejects invalid typed
field values before mutation. Human paste into a free-text scalar field follows
the interactive editor's existing non-blocking policy: it stores the visible
text and shows the same validation hint. Structural constraints that have no
free-text stored shape, including option selection, option deduplication, and
options-from-supertag target eligibility, remain blocking for every source.

Materialization dispatches by destination:

| Destination | Behavior |
| --- | --- |
| Normal parent | Create the node kind, rich content, description, checkbox, tags, fields, then recursively materialize ordinary children. |
| Existing title | Merge the first pasted block into the selected range, apply its metadata to the existing node, create its children below that node, and place later roots as siblings. |
| Direct child of `fieldEntry` | Use field-aware value commands and field-type policy; never call the generic tree insertion primitive for the direct value. |
| Child of a stored value | Use the normal-node materializer. If it is promoted into the `fieldEntry`, subsequent operations recognize it as a direct value. |
| Search node/query condition | Use the search builder and query validation, with no document tag/field side effects. |

For direct field values:

- `plain` accepts rich text or a whole-row reference. Rich text validation uses
  its visible text while preserving marks and inline references.
- `options` selects/deduplicates an existing option or uses the established
  collected-option policy. It never creates a plain child that merely looks
  like an option.
- `options_from_supertag` requires and validates a reference target from the
  configured source supertag.
- `date`, `number`, `url`, `email`, and `checkbox` use their existing canonical
  value validation and stored shapes. A stored checkbox value remains an
  ordinary expandable row; only an empty checkbox field uses the whole-field
  control.
- Tags, nested fields, checkbox state, and ordinary children are applied to a
  newly created plain scalar value exactly as they are to a normal node.
- A reference-shaped value, including a plain whole-row reference, selected
  option, or options-from-supertag value, may not carry implicit tags, nested
  fields, description, checkbox state, or children. Preflight rejects it with a
  diagnostic that tells the caller to mutate the referenced target explicitly.
  This prevents an ingest operation from silently changing global target state.

All deterministic definition/option creation is part of the plan and the same
undo group. Preflight itself creates nothing. Dedupe is computed by stable id
first and canonical name second, matching existing `resolveFieldWriteTarget`
and option-selection rules.

### 7. Canonical outline serializer

The strict parser and serializer form one reversible grammar. The serializer is
used for agent reads/edits and the plain-text clipboard fallback; it is not used
for internal duplication.

Define escaping in the grammar rather than relying on scan order:

- `\\` represents a literal backslash.
- A backslash before grammar-significant punctuation keeps the following token
  literal. The serializer escapes literal tag starts, field separators, checkbox
  markers, reference/directive starts, description separators, Markdown mark
  delimiters, and fence-like line starts when they would otherwise be parsed.
- Bracketed tag/reference labels use their existing explicit escaping for `]`,
  backslash, and newline-style characters.
- Rich marks serialize to canonical Markdown only after literal delimiters in
  the underlying text are escaped.
- Code blocks choose a fence longer than any same-character run in the body.
- A field value with metadata or children always uses the expanded form. A
  single scalar with no marks, references, metadata, or children may use
  `Field:: value`; empty and multi-value fields use
  the unambiguous expanded form.

The contract is structural equivalence:

```text
parse(serialize(draft)) == canonicalize(draft)
```

Source spans, source ids that must be regenerated, harmless whitespace, and
ordering of deduplicated identical tags are excluded from equality. Everything
user-observable is included: rich marks, link hrefs, inline references, tags,
fields, value/direct-child boundaries, checkbox state, descriptions, node
kinds, code language, search operands, and ordinary children.

Property tests generate grammar-significant punctuation, Unicode, URLs,
references, fields, deep trees, multiple values, and protected-range overlap.
Regression fixtures cover every previously divergent consumer.

### 8. Complete reads without hidden clone limits

`node_read` keeps bounded pages. Each field value row adds `hasChildren` and
`childCount` (and may include a `ChildrenPage` when requested by depth), while
retaining `valueNodeId`. An agent can call `node_read` on that id to page its
ordinary descendants with the existing `child_offset`/`child_limit` contract.

The owning field reports only direct values. Descendants never inflate field
cardinality, option selection, filtering, sorting, or validation. Annotated
outline serialization includes value descendants only within the caller's
explicit depth/page bounds and preserves their value boundary.

No mutation path consumes a bounded read as if it were complete. In particular,
`duplicate_id` no longer calls `serializeOutline(..., 12, ..., 500)`.

### 9. Native duplicate and structured clipboard

Expose a core-native clone operation that reuses the proven subtree clone
mechanism but accepts an authorized source, destination parent, and insertion
position. It copies the complete stored subtree and node properties, creates
fresh ids, preserves references as references to their existing targets, and
returns the new root-id mapping. Agent `duplicate_id` validates resource scope
and delegates to this operation directly.

Internal selection copy writes two clipboard representations atomically:

```ts
interface TenonClipboardEnvelopeV1 {
  schema: 'tenon.node-draft';
  version: 1;
  roots: Array<{
    role: 'node' | 'field-entry' | 'field-value';
    draft: NodeDraft;
  }>;
}
```

The custom format is `application/x-tenon-node-draft+json`; the envelope also
contains the numeric version so platform format normalization cannot erase
versioning. `text/plain` contains canonical outline syntax.

Selection is reduced to selected roots, then each complete subtree is exported
even when descendants are collapsed or not selected. This makes cut safe: the
data deleted is the data placed on the clipboard. Cut performs deletion only
after both clipboard representations are successfully written.

A narrow preload/main bridge owns custom clipboard buffers because renderer
`navigator.clipboard.writeText` cannot atomically write the private format. The
bridge accepts only the named Tenon format, validates version and a bounded byte
size, and is callable only from the main application window. Paste prefers a
valid structured envelope, then HTML, then plain text. Unknown versions,
malformed JSON, stale reference ids, or an oversized private payload fall back
to plain text without executing embedded data.

Destination rules remain explicit. A copied field entry pasted under a normal
node recreates that field through field resolution. A copied direct value pasted
inside a compatible field uses field-aware value materialization; outside a
field it becomes an ordinary node draft. Incompatible field destinations fail
atomically and leave the clipboard unchanged.

### 10. Large-input execution

The same pipeline handles one line and tens of thousands of lines. There is no
separate "bulk parser" with weaker semantics.

Execution has three bounded stages:

1. Parse/scan into `NodeDraft` while yielding by elapsed-time budget for large
   inputs. HTML DOM conversion remains renderer-owned; plain/agent adapters stay
   pure and testable outside Electron.
2. Preflight the entire draft against one document revision. Compute all
   resolutions, validation errors, counts, and the materialization schedule
   before writing.
3. Execute that plan through the existing document mutation queue and yielding
   core transaction. Yield/commit cadence is adaptive to elapsed time rather
   than assuming every node costs the same; definition-heavy rows are much more
   expensive than plain rows.

The threshold between immediate and yielding execution is an implementation
constant backed by a probe; crossing it changes scheduling only. Chunk commits
remain inside one explicit undo group. Projection emission and renderer
selection/focus happen once at settlement, and text-search-index refresh uses
its yielding path. A deterministic validation failure creates zero nodes. An
unexpected execution failure rolls back or compensates all roots created by the
plan before reporting failure; partially visible imports are not a result
state.

Add `scripts/probe-semantic-ingest.ts` with plain, tag/field-heavy, wide, and
deep fixtures. It records parse, preflight, materialization, maximum event-loop
stall, projection settlement, and undo time at 1k and 10k nodes; a 50k parse and
preflight case guards algorithmic scaling without requiring a 50k persisted
fixture in every test run. The acceptance target is bounded responsiveness, not
an unrealistically short total duration: the event loop continues to service a
heartbeat throughout materialization and one undo removes the whole batch.

### 11. Complete feature PRs

#### PR A: shared scanner and reversible normal-node grammar

User-visible outcome: agent-created bare URLs are clickable, and normal-node
tags/fields/marks behave the same for agent, single-line paste, multiline paste,
and HTML paste. Search operands remain literal.

Primary areas:

- `src/core/textSyntax.ts`, `src/core/markdownPaste.ts`,
  `src/core/markdownRichText.ts`, and new `src/core/semanticIngest/*` scanner /
  range-edit / serializer modules;
- `src/main/agentOutlineParser.ts`, `src/main/agentNodeToolRead.ts`, and
  `src/main/agentNodeToolSearch.ts`;
- `src/renderer/ui/interactions/pasteParser.ts`,
  `src/renderer/ui/editor/RichTextEditor.tsx`, and trailing paste consumers;
- focused core/renderer/E2E grammar, protected-range, URL-click, HTML-metadata,
  single-line, search-operand, and round-trip tests;
- current-behavior updates in `docs/spec/agent-tool-design.md`,
  `docs/spec/search-query-grammar.md`, and `docs/spec/ui-behavior.md`.

This PR is complete without changing field-value behavior: it fixes and locks
normal-node semantics. It defines the final recursive `NodeDraft`/`FieldDraft`
contract up front; current scalar field inputs are represented as leaf value
drafts, so PR B activates richer producers and consumers without replacing the
contract.

#### PR B: recursive field values and destination-aware materialization

User-visible outcome: tags and rich semantics on plain field values are applied,
`Field:: Value -> Child` preserves the child, and paste into any field routes
through its actual field rules.

Primary areas:

- the already-defined recursive `NodeDraft`/field contract at the core command
  boundary, plus the canonical field grammar;
- `src/main/agentOutlineParser.ts`, `src/main/agentNodeTools.ts`,
  `src/main/agentNodeToolProjection.ts`, and `src/main/agentNodeToolRead.ts`;
- `src/core/core.ts`, `src/core/fieldResolution.ts`, and the smallest coordinated
  changes required in `src/core/types.ts` / `src/core/commands.ts`;
- `src/main/documentService.ts`, `src/renderer/api/client.ts`,
  `src/renderer/ui/outliner/OutlinerItem.tsx`, and field-value materialization
  helpers;
- direct-value, descendant, typed-field, option-dedupe,
  options-from-supertag, reference-shaped rejection, read-pagination, and undo
  tests; current specs in `commands.md`, `agent-tool-design.md`, and
  `ui-behavior.md`.

This is the protocol-owner PR. Its shared contract is reviewed and landed before
PR C or D builds on it. If integration requires a separate interface-only
carve-out, that carve-out must adapt every existing create/paste caller and pass
contract tests on its own; it cannot ship an unused alternate payload.

#### PR C: exact duplicate and internal clipboard transfer

User-visible outcome: duplicate, copy, cut, and internal paste preserve complete
subtrees and semantics beyond visible/depth limits, while other apps still
receive readable text.

Primary areas:

- core native clone/export helpers and agent `duplicate_id` routing;
- a versioned clipboard envelope/validator;
- narrow handlers in `src/main/main.ts` and `src/preload/index.ts`;
- renderer selection serialization, keyboard copy/cut, and paste routing in
  `selectionActions.ts`, `useWorkspaceKeyboard.ts`, and editor interaction
  helpers;
- exact-clone, collapsed-subtree, field-role, invalid-version/size, text
  fallback, cut-write-failure, resource-scope, and deep/wide regression tests;
- clipboard and agent-tool current-behavior specs.

#### PR D: preflighted yielding ingest and complete bounded reads

User-visible outcome: large agent creates and large pastes use the same semantics
without freezing the app, settle atomically, and remain fully discoverable
through bounded agent reads.

Primary areas:

- semantic preflight/materialization-plan modules;
- yielding execution in `src/core/core.ts` and `src/main/documentService.ts`;
- routing for renderer paste and agent create, plus projection/index settlement;
- field-value child summaries and pagination in agent read types/projection;
- `scripts/probe-semantic-ingest.ts`, fake-clock scheduling tests, 1k/10k
  integration fixtures, rollback/undo tests, and current command/agent specs.

### 12. Requirements and acceptance criteria

- **FR-1:** All text-derived ordinary nodes use the shared inline scanner.
  - **AC-1:** When an agent creates a node containing a bare supported URL, the
    stored `RichText` contains a link mark with the normalized href and the
    rendered link opens through the existing safe URL path.
  - **AC-2:** When equivalent `#tag`, `field:: value`, checkbox, Markdown link,
    or inline-reference text enters through agent, plain paste, or HTML paste,
    the resulting observable node semantics are equivalent.
  - **AC-3:** If a tag/field-shaped token appears inside a link, code span,
    reference marker, escaped range, or search operand, it remains literal.
  - **AC-4:** For generated drafts, parsing canonical serialization produces a
    structurally equivalent draft, including grammar-significant literal text.

- **FR-2:** Field values are recursive drafts and materialize by destination.
  - **AC-5:** When strict outline input contains `Field::`, a direct value with a
    tag, and an indented child, the tag belongs to the plain value and the child
    is an ordinary descendant rather than a second value.
  - **AC-6:** When a structured paste creates direct values in plain, options,
    options-from-supertag, date, number, URL, email, or checkbox fields, each
    value follows the same validation/dedupe/storage rules as interactive field
    creation.
  - **AC-7:** If a reference-shaped value includes implicit metadata or
    descendants, preflight rejects the operation before mutation and identifies
    the source span and explicit recovery action.
  - **AC-8:** A parent `node_read` reports direct field values and their child
    counts; reading a value id returns pageable ordinary descendants without
    counting them as field values.

- **FR-3:** Exact internal transfers never depend on bounded text reads.
  - **AC-9:** `duplicate_id` clones a fixture deeper than 12 levels and wider
    than 500 children with rich text, fields, tags, references, node kinds, and
    all descendants intact and with fresh ids.
  - **AC-10:** Internal copy/cut/paste of collapsed selected roots restores the
    complete structured subtrees; one undo removes the paste and cut deletes
    only after clipboard write succeeds.
  - **AC-11:** If the private clipboard payload is absent, invalid, oversized,
    or a future version, paste safely falls back to canonical plain text.

- **FR-4:** Large input uses preflighted cooperative execution.
  - **AC-12:** A deterministic error anywhere in a large draft creates zero
    document nodes or definitions and returns a source-grounded diagnostic.
  - **AC-13:** A 10k-node materialization services the heartbeat probe while it
    runs, emits its settled projection once, and is removed by one undo.
  - **AC-14:** One-line and large-fixture paths produce structurally equivalent
    results for the same drafts; scheduling thresholds do not alter semantics.

### 13. Risks, edge cases, and mitigations

- **Grammar compatibility:** canonical escaping changes agent-visible outline
  text and therefore `old_string` matching. Land parser and serializer together,
  pin annotated-edit fixtures, and treat prior model-visible strings as
  historical output rather than a persisted format.
- **Protected-range offset drift:** removing metadata after Markdown/HTML mark
  creation can corrupt offsets. Use one range-edit primitive and property-test
  overlapping marks, inline references, surrogate pairs, and Unicode tags.
- **Search regression:** a globally eager tag scanner can steal query operands.
  Require an explicit scan context in every adapter and test every query
  operator with tag-shaped and field-shaped literal values.
- **Field corruption:** generic insertion beneath a `fieldEntry` bypasses option
  and cleanup rules. Make destination classification a core precondition and add
  a guard that rejects generic direct-value insertion.
- **Reference side effects:** metadata on a projected reference can accidentally
  mutate a shared target. Reject enriched reference-shaped values during
  preflight rather than guessing ownership.
- **Stale preflight:** definitions or insertion positions can change while a
  plan waits in the queue. Bind plans to a revision and re-preflight inside the
  serialized mutation queue.
- **Chunked atomicity:** intermediate CRDT commits can survive an unexpected
  error. Keep created-root bookkeeping, one undo group, and an exercised
  rollback/compensation path before routing user paste through chunk commits.
- **IPC/clipboard size:** structured clone and clipboard buffers can become a
  second long task. Validate bounded envelopes, measure transport separately,
  and chunk/stage only above the measured threshold without changing the AST.
- **Security:** link creation must not widen the existing external-navigation
  allowlist, and custom clipboard data is untrusted input. Normalize supported
  links, keep `javascript:`/file/custom schemes inert, validate every clipboard
  discriminant, and never treat clipboard strings as executable content.

## Collision Result

- PR #394 is merged and is a dependency, not a collision. Its direct-value /
  ordinary-descendant boundary is incorporated above.
- PR #393 is merged and removes the obsolete reference field type. This plan
  uses reference-shaped values only.
- The only open claim found during planning is PR #396, URL preview bilingual
  translation. Its overlap is limited to `src/main/main.ts` and
  `docs/spec/ui-behavior.md`; scanner, field AST, agent parser/read, core
  materializer, and tests do not overlap. Sequence PR C's clipboard IPC after
  #396 or rebase it before touching those two files.
- `src/core/types.ts` and `src/core/commands.ts` are infrastructure-owned. PR B
  must claim and coordinate their exact contract before dependent work begins.
  `docs/TASKS.md` and `CHANGELOG.md` remain main-agent-owned and are not part of
  dev-agent implementation diffs.

## Open Questions

None. Yield budgets, byte limits, and the immediate/yielding threshold are
reversible implementation constants selected from the required probe; they do
not change the approved product semantics.

## Validation Checklist

- [ ] `bun run typecheck` passes for every PR.
- [ ] `bun run test:core` and `bun run test:renderer` pass for every affected
  consumer.
- [ ] Focused Playwright coverage verifies agent-created and pasted links,
  single-line and HTML metadata, direct field-value paste, cut/copy fallback,
  and one-step undo.
- [ ] Canonical grammar property tests and fixed regression fixtures pass.
- [ ] Search-operand fixtures cover every executable query operator.
- [ ] Deep (>12), wide (>500), protected-range, Unicode, and
  reference-shaped-value fixtures pass without truncation or target mutation.
- [ ] `scripts/probe-semantic-ingest.ts` records 1k/10k execution and 50k
  parse/preflight results, including heartbeat stalls and undo time.
- [ ] Custom clipboard version/size/schema validation and link-scheme security
  tests pass.
- [ ] Light and dark manual verification confirms existing link and field-row
  presentation remains legible with no layout shift.
- [ ] `bun run docs:check` and `git diff --check` pass.
