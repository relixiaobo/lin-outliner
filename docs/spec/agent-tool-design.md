# Agent Tool Design

This document defines the tool protocol exposed to the Lin agent runtime.

The design follows the nodex tool model: keep the public tool set small, make
each tool domain-aware, and let tool parameters express outliner semantics such
as tags, fields, references, movement, and undoable operations. Lin should not
expose one tool per UI command unless the operation has a clearly separate agent
role.

## Goals

- Let the agent perform the same document operations a user can perform.
- Keep the outliner tool set compact and predictable.
- Put outliner semantics in TypeScript-backed tools, not in the model prompt.
- Make every mutation previewable, auditable, and undoable.
- Return structured results that tell the agent what happened and how to
  recover from partial success.
- Avoid a generic `node_batch` or `outliner_write` meta-tool.

## Non-Goals

- Do not expose a separate tool for reading active UI context. Active workspace,
  panel, selected nodes, visible nodes, and recent user edits are injected into
  each user turn as a system reminder.
- Do not simulate UI gestures such as clicking buttons or pressing Tab. Tools
  expose the document operation behind the gesture.
- Do not expose internal Electron IPC command names as the public agent API.
- Do not make file, bash, or web tools responsible for outliner mutations.

## Tool Registry

### P0 Tools

These tools are required for the first useful local agent.

| Tool | Kind | Mutates | Approval | Purpose |
|---|---|---:|---|---|
| `node_search` | outliner | No | No | Execute temporary search outlines or saved search node queries. |
| `node_read` | outliner | No | No | Read node raw type/data, fields, and bounded children. |
| `node_create` | outliner | Yes | Usually yes | Create outline trees, references, search/view nodes, schema nodes, or duplicates. |
| `node_edit` | outliner | Yes | Usually yes | Edit the annotated outline for a known node using exact string replacement, or perform explicit structure operations such as move and merge. |
| `node_delete` | outliner | Yes | Usually yes | Trash or restore one or more nodes. |
| `operation_history` | outliner | Yes for undo/redo | Usually yes | Inspect, undo, or redo user and agent operations. |
| `file_read` | local | No | Usually no | Read local files with bounded output. |
| `file_glob` | local | No | No | Find files by glob or path pattern. |
| `file_grep` | local | No | No | Search file contents under allowed roots. |
| `file_edit` | local | Yes | Yes | Apply exact string replacements to files. |
| `file_write` | local | Yes | Yes | Create files or rewrite whole files. |
| `bash` | local | Depends | Usually yes | Run local commands with timeout and output limits. |
| `task_stop` | local | Yes | Usually yes | Stop background commands created by `bash`. |
| `web_search` | web | No | Depends | Search the web for current external information. |
| `web_fetch` | web | No | Depends | Fetch and read a specific URL with pagination or snippet search. |

### P1 Tools

These should be added after P0 approval rendering and undo are stable.

| Tool | Kind | Mutates | Approval | Purpose |
|---|---|---:|---|---|
| `past_chats` | agent | No | No | Search and read older Lin agent conversations. |

### Deferred Tools

Browser automation, MCP tools, skills, and sub-agents should wait until Lin has a
specific workflow for them. A larger registry increases prompt cost and makes
permission behavior harder to reason about.

## Naming Rules

- Use lower snake case.
- Use `node_*` for outliner graph operations, following nodex.
- Use `file_*` for local filesystem operations.
- Use `bash` for shell execution.
- Use `task_stop` for stopping background commands created by `bash`.
- Use `web_*` for network read tools.
- Local file tools should mirror proven read, edit, write, glob, and grep roles,
  while keeping Lin's lower snake case names.
- The local tool list is intentionally smaller than broader terminal-first tool registries.
  Compatibility aliases and history-shaped tools such as `KillShell`,
  `TaskOutput`, and old agent-output readers are not exposed; background output
  should be surfaced through runtime events or persisted paths that can be read
  with `file_read`.
- Do not use a generic `node_batch`; batch capability belongs inside the
  relevant tool parameters.

## Tool Description Style

Tool descriptions and parameter descriptions are part of the agent prompt. They
should be written as operational guidance, not as implementation notes:

- Say when to use the tool and when to use a neighboring tool instead.
- Describe the exact model-facing input contract, including defaults and
  pagination/preview behavior.
- Keep wording close to proven references: nodex for `node_*`, dedicated local
  file/bash tools, and a search/fetch split for `web_*`.
- Avoid exposing internal implementation details unless the model must act on
  them, such as `%%node:id%%` markers, `operation_id` guards, or `nextOffset`.
- Do not promise capabilities that are not implemented.

## Tool Result Layers

Tool results have three separate audiences:

- pi-agent-core result: every tool `execute` returns native
  `AgentToolResult<T>` with `content`, `details`, and optional `terminate`.
- Runtime envelope: Lin stores the common envelope in `details` for status,
  metrics, debugging, permissions, UI rendering, export, and tests.
- Model-visible result: the smallest stable protocol the agent needs for the
  next action.
- UI detail view: optional rich rendering derived from `details`, not from the
  model-visible text.

Lin error envelopes (`ok: false`) are converted in the shared `afterToolCall`
adapter to pi-agent-core's native `ToolResultMessage.isError = true`. Tools
should not invent a separate `isError` field inside `AgentToolResult`.

Do not expose the runtime envelope as the node tools' model-facing contract.
The agent should see an action protocol, not a trimmed copy of implementation
state.

```ts
interface ToolResult<TData = unknown> {
  ok: boolean;
  tool: string;
  version: 1;
  status: "success" | "partial" | "unchanged" | "denied" | "error";
  data?: TData;
  error?: ToolError;
  operation?: OperationResult;
  preview?: ToolPreview;
  validation?: ValidationReport;
  boundary?: string;
  instructions?: string;
  warnings?: string[];
  pagination?: Pagination;
  metrics?: ToolMetrics;
}

interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
  details?: unknown;
}

interface OperationResult {
  operationId: string;
  undoGroupId?: string;
  origin: "agent" | "user" | "system";
  action: string;
  affectedNodeIds?: string[];
  affectedPaths?: string[];
  affectedRevisions?: Record<string, string>;
  summary: string;
}

interface Pagination {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

interface ToolMetrics {
  durationMs?: number;
  truncated?: boolean;
  outputBytes?: number;
}
```

For `node_*`, model-visible `content.text` uses one concise envelope. Runtime
debug details stay in `details`; the model-facing payload avoids duplicated
representations.

```ts
interface NodeVisibleEnvelope {
  ok: boolean;
  tool: string;
  status: "success" | "partial" | "unchanged" | "denied" | "error";
  instructions?: string;
  data?: NodeVisibleResult;
  error?: ToolError;
  warnings?: string[];
}

type NodeVisibleResult =
  | NodeVisibleReadResult
  | NodeVisibleSearchResult
  | NodeVisibleCountResult
  | NodeVisibleMutationResult;

interface NodeVisibleReadResult {
  kind: "read";
  outline?: string;
  page?: NodeVisiblePage;
}

interface NodeVisibleSearchResult {
  kind: "search";
  outline?: string;
  page: NodeVisiblePage;
}

interface NodeVisibleMutationResult {
  kind: "mutation";
  action: "create" | "edit" | "delete";
  status: "applied" | "preview" | "unchanged";
  changes: NodeVisibleChanges;
  outline?: string;
}

interface NodeVisibleCountResult {
  kind: "count";
  total: number;
  page: NodeVisiblePage;
}

interface NodeVisibleChanges {
  created?: string[];
  updated?: string[];
  moved?: string[];
  trashed?: string[];
  restored?: string[];
}

interface NodeVisiblePage {
  total: number;
  offset: number;
  limit: number;
  next_offset?: number;
}
```

Rules:

- `outline` is the single model-visible representation for read/search results.
  It is an annotated outline: `%%node:id%%` is protocol metadata, not node text.
- Mutating tools return `changes` and, when useful, a fresh annotated `outline`
  for follow-up edits.
- Full structured payloads such as `NodeReadItem`, `NodeSearchItem`,
  `beforeOutline`, `afterOutline`, and raw preview details remain available in
  `details`.
- `summary` is not part of the model-visible node protocol. Human-facing summary
  text belongs in UI rendering or `details`.

Guidance is first-class:

- `instructions`: the current state, recommended next action, boundary, and
  recovery guidance in one field.

Use `instructions` for unknown tags, unresolved fields, permission denials,
truncation, no-op updates, and ambiguous targets.

`ToolPreview` and `ValidationReport` are defined in the TypeScript parser section
because they are produced by the mutation planner, but they belong in the common
envelope for every previewable mutating tool.

## Error Handling

Tools should return a normal `ToolResult` with `status: "error"` rather than
throwing through the agent loop, except for adapter bugs or runtime crashes.

Example:

```json
{
  "ok": false,
  "tool": "node_edit",
  "version": 1,
  "status": "error",
  "error": {
    "code": "node_not_found",
    "message": "Node not found: node_123",
    "recoverable": true
  },
  "instructions": "Use node_search or node_read on the parent context to find the correct node id. The node id may be stale after a delete, restore, or undo."
}
```

## Node Tool Contract

Node tools use the compact nodex-style surface, but Lin does not expose nodex's
incremental `text` edit contract. Lin uses one outline grammar for creation,
reading, and text replacement edits. Read/search results are annotated with
`%%node:id%%` markers so ids and content are not returned in two parallel
structures:

- `node_create.outline` inserts new structure.
- `node_read(...)` serializes existing structure as annotated outline.
- `node_edit.old_string/new_string` edits that serialized outline by exact string
  replacement, then TypeScript parses and applies the result.

`%%node:id%%` is the only agent-visible identity marker. It is protocol metadata,
not node text, and the parser strips it before applying content changes. Do not
embed internal CRDT metadata, timestamps, or other implementation markers in
outline text.

`operation_history` is a Lin extension over nodex's AI-only `undo` tool. Keep it
separate from the `node_*` tools.

Read/create/edit symmetry:

- `node_read` returns one annotated `outline` for the requested node subtree.
- `node_create` accepts the same content grammar without `%%node:id%%` markers. The
  insertion point is controlled by `parent_id` and `after_id`; omitted `parent_id`
  means today's journal node, not the currently focused UI node.
- `node_edit` targets one existing root by `node_id`, applies exact
  `old_string/new_string` replacement to the outline returned by `node_read`, and
  then lets TypeScript parse the full resulting outline.
- Precise child edits should target that child's node id directly. Parent
  context is only needed when inserting, moving, or disambiguating repeated text.

## Lin Outline Format

The Lin Outline Format is a parser-backed text representation for outliner
content. It is used by `node_create`, `node_read`, and `node_edit`. TypeScript
may do fast schema checks, but TypeScript owns parsing, resolution, preview,
validation, and application.

Agent-facing syntax:

```text
- Project Alpha - Q2 customer rollout #project
  - Status:: Active
  - Owner:: [[node:Alice^node_alice]]
  - [ ] Follow up
  - Notes
    - Prepare agenda
  - %%search%% Open tasks %%view:table%%
    - AND
      - HAS_TAG
        - tag:: [[node:#task^node_task_tag]]
      - FIELD_IS
        - field:: [[node:Status^node_status_field]]
        - value:: Open
```

Rules:

- Every non-empty line starts with `- ` after indentation.
- Indentation is exactly 2 spaces per level. Tabs and uneven indentation are an
  error in model-facing output.
- `- title` creates or serializes a node title.
- `- title - description` sets a node description. The first ` - ` separates
  title from description; later ` - ` text stays in the description.
- `#tag` and `#[[multi word tag]]` apply tags.
- Bare CSS hex colors such as `#fff`, `#ffff`, `#112233`, and `#112233ff`
  are color text, not tags. Use explicit bracket syntax such as `#[[fff]]` if a
  tag name intentionally looks like a hex color.
- `[ ]`, `[x]`, and `[X]` at the start of a node set checkbox state.
- `Field:: value` sets a single field value.
- `Field::` followed by indented value lines sets a multi-value field.
- `Field::` without values clears that field in edit results.
- Date field values use the canonical date field language from
  `docs/spec/date-field-values.md`: `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or
  `start/end` with `/`, for example `2026-05-20/2026-05-24`. Tool prompts and
  search query operands must not teach `..` or other date range syntax.
- Whole-line `[[node:Display^...]]` creates a reference node or reference field
  value.
- Inline `[[node:Display^...]]` creates an inline reference inside node text or a
  field value.
- Date nodes are referenced by id with `[[node:Display^...]]`; date shortcut
  syntax is not part of the model-facing outline contract yet.
- `%%search%%` turns the node into a search node. In `node_create` this creates a
  saved search node; in `node_search` it is a temporary search node that is only
  executed and rendered.
- A search node must contain exactly one query root child. `AND`, `OR`, and
  `NOT` are query group nodes and may be nested. QueryOp names such as
  `STRING_MATCH`, `HAS_TAG`, `LINKS_TO`, `FIELD_IS`, `LT`, and `DATE_OVERLAPS`
  are rule nodes. Rule operands are represented with `field::`, `tag::`,
  `target::`, `value::`, or `operand::` lines under the rule. `field`, `tag`,
  and `target` operands must be exact node references or ids.
- `%%view:table%%`, `%%view:list%%`, `%%view:cards%%`, and similar directives set
  view presentation for nodes that support views.

Runtime compatibility:

- Tool descriptions should teach only the canonical format above.
- TypeScript may accept copied list text, missing bullets, tabs, or other paste
  variants through a compatibility normalizer.
- Compatibility normalization is not a prompt contract. If normalization changes
  meaning or cannot be made deterministic, return a parse error with line and
  column guidance.

Parser AST:

```ts
interface OutlineDocument {
  roots: OutlineNode[];
}

interface OutlineNode {
  title: string;
  description?: string | null;
  tags: TagRef[];
  checked?: boolean | null;
  fields: OutlineField[];
  children: OutlineNode[];
  refs: InlineRef[];
  directives: OutlineDirective[];
  sourceSpan: SourceSpan;
}

interface OutlineField {
  name: string;
  values: OutlineValue[];
  clear: boolean;
  sourceSpan: SourceSpan;
}

interface OutlineValue {
  text: string;
  refs: InlineRef[];
  targetId?: string;
  date?: string;
  sourceSpan: SourceSpan;
}

interface TagRef {
  name: string;
  targetId?: string;
}

type ReferenceTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "local-file"; path: string; entryKind: "file" | "directory" };

interface InlineRef {
  display: string;
  target: ReferenceTarget;
  offset?: number;
  mimeType?: string;
  sizeBytes?: number;
}

interface OutlineDirective {
  kind: "search" | "view" | "code" | "image";
  value?: string;
  args?: Record<string, string>;
}

interface SourceSpan {
  line: number;
  column: number;
  length: number;
}
```

Shared outliner type names used below:

```ts
type NodeKind =
  | "node"
  | "fieldEntry"
  | "reference"
  | "codeBlock"
  | "image"
  | "embed"
  | "tagDef"
  | "fieldDef"
  | "viewDef"
  | "sortRule"
  | "search"
  | "queryCondition"
  | "date";

type FieldType =
  | "plain"
  | "options"
  | "options_from_supertag"
  | "date"
  | "number"
  | "url"
  | "email"
  | "checkbox";
```

### Resolution

Resolution happens after parsing and before preview.

Tags:

1. Trim, remove a leading `#`, and case-fold.
2. Match exact display name.
3. Optionally fuzzy match above a conservative threshold.
4. If policy allows, auto-create the tag definition.
5. Otherwise report `unresolvedTags`.

Fields:

1. Resolve fields available from the node's applied tags.
2. Match exact display name.
3. Optionally fuzzy match above a conservative threshold.
4. If the node has at least one tag and policy allows, create the field
   definition under the first tag.
5. Otherwise report `unresolvedFields`.

Field type inference:

- `date`, `deadline`, `due`, `start`, `end`, etc. -> `date`
- `url`, `link`, `website`, or `http(s)://` values -> `url`
- `email` or email-shaped values -> `email`
- `count`, `number`, `amount`, `price`, `qty`, etc. -> `number`
- otherwise -> `options`

References:

- `[[node:Display^...]]` requires the target id to exist and the target must not be in
  Trash.
- Date references use normal node references to existing date node ids.
- Search query operands use explicit node references or exact ids for `field::`,
  `tag::`, and `target::`.

## Outliner Tools

### `node_search`

Execute a temporary or saved search node. Use this to locate nodes before
editing and to render temporary search results without creating a real node.
`node_search.outline` uses the same search-node outline shape that
`node_create.outline` would use to create a saved search node.
Date query operands use the same canonical date field value language as
stored date fields.
The canonical query grammar is specified in `docs/spec/search-query-grammar.md`.

Parameters:

```ts
interface NodeSearchParams {
  outline?: string;
  search_node_id?: string;
  limit?: number; // default 20, max 50
  offset?: number;
  count?: boolean;
}
```

Exactly one of `outline` and `search_node_id` is required.

Return data:

```ts
interface NodeSearchData {
  source: "temporary" | "saved";
  title?: string;
  view?: string;
  searchNodeId?: string;
  outline?: string;
  total: number;
  offset: number;
  limit: number;
  items?: NodeSearchItem[];
}

interface NodeSearchItem {
  nodeId: string;
  title: string;
  description?: string | null;
  type: NodeKind;
  tags: string[];
  snippet: string;
  parent?: { nodeId: string; title: string } | null;
  fields: Record<string, string | string[]>;
  checked?: boolean | null;
  hasChildren: boolean;
  childCount: number;
  updatedAt: string;
}
```

Result behavior:

- `outline` is a temporary search node and does not mutate document state.
- The outline must parse as one `%%search%%` root with exactly one query root
  child.
- Keyword search is represented as a `STRING_MATCH` rule, for example
  `- %%search%% 成都天气\n  - STRING_MATCH\n    - value:: 成都天气`. There is no
  separate `query` parameter.
- The root title is returned as `title` and may be used for temporary UI display.
- `%%view:table%%`, `%%view:list%%`, `%%view:cards%%`, and similar directives are
  returned as `view` and drive temporary result presentation.
- Child lines are the canonical query tree used by saved search nodes. Group
  nodes are `AND`, `OR`, and `NOT`; rule nodes are QueryOp names. Rule operands
  use `field::`, `tag::`, `target::`, `value::`, or `operand::`.
- Invalid, missing, trashed, or wrong-type operand references are errors. The
  tool does not silently drop unresolved structured conditions.
- `search_node_id` executes an existing saved search node.
- Subtree restriction, parent restriction, backlink search, and relationship
  filters should be represented as search conditions in the outline, not as
  separate tool parameters.
- Model-visible search results return one annotated outline of matches, not
  separate `matches` and `refs` arrays.
- `count: true` returns `kind: "count"` with total and guidance without item
  payloads.

Examples:

```json
{
  "outline": "- %%search%% 成都天气 %%view:list%%\n  - STRING_MATCH\n    - value:: 成都天气"
}
```

```json
{
  "outline": "- %%search%% 今日开放任务 %%view:table%%\n  - AND\n    - HAS_TAG\n      - tag:: [[node:#task^node_task_tag]]\n    - FIELD_IS\n      - field:: [[node:Status^node_status_field]]\n      - value:: Open",
  "limit": 20
}
```

```json
{
  "search_node_id": "node_saved_search"
}
```

### `node_read`

Read nodes as structured data in `details` and as annotated Lin Outline Format
for the model-visible result. The outline carries `%%node:id%%` markers so the
agent has one source of truth for both content and ids.

Parameters:

```ts
interface NodeReadParams {
  node_id?: string; // default: today's journal node
  node_ids?: string[];
  depth?: number; // 0 = node only, default 1, max 3
  child_offset?: number;
  child_limit?: number; // default 20, max 50
  include_deleted?: boolean;
  include_backlinks?: boolean;
}
```

Return data:

```ts
interface NodeReadData {
  items: NodeReadItem[];
}

interface NodeReadItem {
  nodeId: string;
  type: NodeKind;
  title: string;
  description?: string | null;
  tags: string[];
  fields: NodeFieldRead[];
  checked?: boolean | null;
  parent?: { nodeId: string; title: string } | null;
  breadcrumb: Array<{ nodeId: string; title: string }>;
  children: ChildrenPage;
  backlinks?: NodeBacklink[];
  revision: string;
  outline?: string;
}

interface NodeFieldRead {
  name: string;
  type: FieldType | string;
  values: Array<{
    text: string;
    valueNodeId?: string;
    targetId?: string;
  }>;
  fieldEntryId: string;
  options?: string[];
}

interface ChildrenPage {
  total: number;
  offset: number;
  limit: number;
  items: NodeChildSummary[];
}

interface NodeChildSummary {
  nodeId: string;
  title: string;
  type: NodeKind;
  tags: string[];
  checked?: boolean | null;
  hasChildren: boolean;
  childCount: number;
  isReference?: boolean;
  targetId?: string;
  children?: ChildrenPage;
}

interface NodeBacklink {
  sourceNodeId: string;
  sourceTitle: string;
  kind: "tree" | "inline" | "field";
  snippet?: string;
}
```

Result behavior:

- Omitted `node_id` reads today's journal node.
- Use either `node_id` or `node_ids`, not both. If both are omitted, read today's
  journal node.
- `node_ids` returns multiple independent `items`.
- Model-visible output contains one annotated outline. Full structured
  `NodeReadItem` data remains available in `details`.
- `outline` serializes the requested node and bounded descendants using the same
  content grammar accepted by `node_create` and `node_edit`, plus agent-only
  `%%node:id%%` markers.
- `%%node:id%%` markers are not node text. Preserve markers for existing nodes
  when editing; omit markers for newly created lines.
- Field entries and field values are serialized on separate lines in annotated
  output so both the field entry id and value node ids can be represented.
- If children are truncated, return pagination and do not serialize hidden
  children into `outline`.
- To edit a child precisely, copy the child line with its `%%node:id%%` marker or
  call `node_edit` directly on that child id.

### `node_create`

Create new outliner content under a parent. The normal path is `outline`, which
may create one node, many sibling nodes, or a full subtree. Reference creation
and subtree duplication are explicit shortcuts because they depend on exact ids.

Parameters:

```ts
interface NodeCreateParams {
  parent_id?: string; // default: today's journal node
  after_id?: string | null; // null = first child; omitted = last child
  outline?: string;
  target_id?: string; // create one reference node to this target
  duplicate_id?: string; // deep-copy this subtree
  preview_only?: boolean;
}
```

Exactly one of `outline`, `target_id`, and `duplicate_id` is required.

Return data:

```ts
interface NodeCreateData {
  parentId: string;
  afterId?: string | null;
  createdRootIds: string[];
  createdNodeIds: string[];
  createdFieldEntryIds?: string[];
  createdTagIds?: string[];
  createdFieldDefIds?: string[];
  duplicatedFrom?: string;
  targetId?: string;
  outline?: string;
}
```

Result behavior:

- If `after_id` is provided without `parent_id`, the parent is `after_id`'s parent.
- If both are provided, `after_id` must be a child of `parent_id`.
- If `outline` has multiple root lines, the first root is inserted at the
  requested position and following roots are inserted after the previous root.
- `target_id` creates one reference node at the requested position.
- `duplicate_id` deep-copies the source subtree at the requested position.
- Missing normal node tags and fields may be created by the outline application
  layer. Search-node `field::`, `tag::`, and `target::` operands must reference
  existing nodes.
- Search/view directives, schema-like tag/field structures, references,
  descriptions, checkboxes, and fields all come through `outline`.
- `node_create.outline` must not contain `%%node:id%%` markers. Those markers are
  only emitted by read/search results and accepted by edit replacements.
- After apply, model-visible data returns a fresh annotated `outline` for the
  created roots.
- Reference targets must exist and must not be in Trash.
- `preview_only: true` returns preview and validation without applying.

Example:

```json
{
  "outline": "- Project Alpha - Q2 rollout #project\n  - Status:: Active\n  - [ ] Draft plan"
}
```

### `node_edit`

Edit existing outliner content. The content edit path uses exact
replacement: read the node, copy an exact fragment from the returned annotated
outline, and replace it with a new annotated fragment.

Parameters:

```ts
type NodeEditParams =
  | NodeOutlineEditParams
  | NodeMoveParams
  | NodeMergeParams
  | NodeReferenceReplaceParams;

interface NodeOutlineEditParams {
  node_id: string;
  old_string: string; // exact fragment from node_read data.outline, or "*" for full outline
  new_string: string;
  expected_revision?: string;
  preview_only?: boolean;
}

interface NodeMoveParams {
  node_id?: string;
  node_ids?: string[];
  move: {
    parent_id?: string;
    after_id?: string | null;
    structural_action?: "indent" | "outdent" | "move_up" | "move_down";
  };
  preview_only?: boolean;
}

interface NodeMergeParams {
  node_id: string; // target node
  merge_from_node_ids: string[]; // source nodes
  preview_only?: boolean;
}

interface NodeReferenceReplaceParams {
  node_id: string;
  replace_with_reference_to: string;
  preview_only?: boolean;
}
```

Outline edit semantics:

- `old_string !== "*"` must match exactly once in the current annotated outline
  for `node_id`.
- `old_string === "*"` is a sentinel that replaces the whole annotated outline for
  `node_id`. It is not a wildcard or regular expression; `*` has special meaning
  only when it is the entire value.
- `new_string` is not parsed in isolation. The full outline after replacement must
  be valid Lin Outline Format.
- Existing lines should preserve their `%%node:id%%` marker. New lines should omit
  it. Removing a marked line means removing/trashing that existing node.
- Whole-line or whole-subtree replacements are preferred. Smaller string
  fragments are allowed when the resulting outline is still valid and the match
  is exact.
- For `old_string: "*"`, `new_string` must contain exactly one root line because
  that root maps to `node_id`.
- TypeScript replaces the matched fragment, parses the resulting whole outline, builds
  a mutation plan, validates it, renders a preview, and then applies it after
  approval when needed.
- The root of a full-outline replacement maps to `node_id`. If the replacement
  would make the root ambiguous, return an error.
- If the root line has a marker, it must match the `node_id` parameter.
- Annotated ids must be unique and must belong to the edited subtree. Moving
  external nodes into the subtree should use the explicit move form.
- For precise child edits, prefer `node_read` to obtain the child id, then
  call `node_edit` on that child. Do not rely on sibling line numbers.
- If an outline edit is ambiguous because identical children have meaningful
  fields, children, references, or history, validation should reject it and tell
  the agent to target the child node id directly.
- Removing an existing node, reference, or field value from the resulting outline
  is a deletion intent. It compiles to an undoable trash/clear mutation, not a
  permanent delete.
- Removing all values from a field compiles to `ClearField`; removing individual
  field value nodes compiles to trashing those value nodes.

Move semantics:

- `parent_id + after_id` is an absolute move.
- `structural_action` mirrors user operations: indent, outdent, move up, move
  down.
- `node_ids` is allowed only for homogeneous move operations.
- Moving a node under itself or under one of its descendants is invalid.

Merge semantics:

- `node_id` is the target that survives.
- `merge_from_node_ids` are sources whose children, fields, tags, and references
  are merged into the target.
- Sources are moved to Trash after merge.
- Source order determines child and field-value append order.
- Target title and position are preserved.
- Matching fields are merged by field display name. If the target already has a
  matching field, source field values move into the target field and the emptied
  source field entry moves to Trash. If the target does not have that field, the
  source field entry moves under the target.
- Merge return data includes those emptied source field entries in
  `trashedNodeIds`, and moved field values or field entries in `movedNodeIds`.
- External tree references to sources are redirected to the target. References
  inside a source subtree are not rewritten during the merge because their parent
  is being moved or trashed as part of the source content.
- Merge cannot be combined with outline edit or move in the same call.

Reference replacement semantics:

- `replace_with_reference_to` replaces the node at `node_id` with a reference node to
  the target at the same parent and position.
- The original node is moved to Trash after the replacement, preserving undo.
- If `node_id` is already a reference, only its target is changed.

Return data:

```ts
interface NodeEditData {
  action: "outline_edit" | "move" | "merge" | "replace_with_reference";
  status: "updated" | "unchanged";
  affectedNodeIds: string[];
  createdNodeIds?: string[];
  trashedNodeIds?: string[];
  matchedNodeIds?: string[];
  movedNodeIds?: string[];
  updatedFields?: string[];
  updatedTags?: string[];
  beforeOutline?: string;
  afterOutline?: string;
  revisions?: Record<string, string>;
  merge?: {
    targetNodeId: string;
    sourceNodeIds: string[];
    movedChildren: number;
    mergedFields: Array<{
      fieldName: string;
      sourceFieldEntryId: string;
      targetFieldEntryId: string;
      movedValueIds: string[];
      mode: "merged_values" | "moved_entry";
    }>;
    appliedTags: number;
    redirectedReferences: number;
  };
}
```

Examples:

```json
{
  "node_id": "node_task",
  "old_string": "*",
  "new_string": "- %%node:node_task%% [x] Check Chengdu weather #weather"
}
```

```json
{
  "node_id": "node_project",
  "old_string": "  - %%node:node_task_b%% Task B\n  - %%node:node_task_c%% Task C",
  "new_string": "  - %%node:node_task_b%% Task B\n  - [ ] Task D\n  - %%node:node_task_c%% Task C"
}
```

```json
{
  "node_ids": ["node_task_a", "node_task_b"],
  "move": { "parent_id": "node_done" }
}
```

```json
{
  "node_id": "node_canonical",
  "merge_from_node_ids": ["node_duplicate_1", "node_duplicate_2"]
}
```

```json
{
  "node_id": "node_old",
  "replace_with_reference_to": "node_canonical"
}
```

### `node_delete`

Move nodes to Trash, or restore them from Trash. Supports a single ID or an
array for batch operations. Works on any node: content, field values, and
references. Deleting a field value node removes that value; deleting a field
entry clears that field. Deleting a reference removes the link.

Parameters:

```ts
interface NodeDeleteParams {
  node_id?: string;
  node_ids?: string[];
  restore?: boolean; // true = restore from Trash; omit/false = move to Trash
  preview_only?: boolean;
}
```

Return data:

```ts
interface NodeDeleteData {
  action: "trashed" | "restored";
  trashId: string;
  requestedNodeIds: string[];
  deletedNodeIds: string[];
  restoredNodeIds?: string[];
  deletedCount: number;
  restoredCount?: number;
  affectedNodeCount: number;
  preview: Array<{
    nodeId: string;
    title: string;
    type: NodeKind;
    parent?: { nodeId: string; title: string } | null;
    childCount: number;
    subtreeNodeCount: number;
  }>;
  skippedNodeIds?: Array<{
    nodeId: string;
    reason: string;
    coveredBy?: string;
  }>;
}
```

Result behavior:

- Use either `node_id` or `node_ids`, not both.
- Validate all node ids before mutating.
- Delete means move to Trash. Agent v1 does not expose permanent delete.
- Restore uses the node's recorded original parent/position when available. If
  the original location is no longer valid, return an error with guidance instead
  of guessing a new parent.
- Batch delete is supported by `node_ids`. This is not a generic batch protocol;
  it is the natural shape of the delete operation.

### `operation_history`

Inspect, undo, or redo operations. Unlike nodex's AI-only `undo`, Lin should
support both user and agent operations because the agent may need to reason about
recent user edits or redo a user action on request.

Parameters:

```ts
interface OperationHistoryParams {
  action?: "list" | "undo" | "redo"; // default "list"
  steps?: number; // default 1, max 10 for undo/redo
  operation_id?: string; // stack-top guard, not arbitrary history jumping
  origin?: "all" | "agent" | "user"; // default: all for list, agent for undo/redo
  limit?: number;  // for list, default 20, max 100
  offset?: number; // for list
}
```

Return data:

```ts
interface OperationHistoryData {
  action: "list" | "undo" | "redo";
  historyMode?: "journal" | "undo_stack";
  count: number;
  total?: number;
  hasMore?: boolean;
  items?: OperationHistoryItem[];
  undone?: OperationHistoryItem[];
  redone?: OperationHistoryItem[];
  canUndo: boolean;
  canRedo: boolean;
  cursor?: {
    topUndoOperationId?: string;
    topRedoOperationId?: string;
  };
}

interface OperationHistoryItem {
  operationId: string;
  origin: "agent" | "user" | "system";
  tool?: string;
  command?: string;
  action: string;
  summary: string;
  affectedNodeIds: string[];
  createdAt: string;
  canUndo: boolean;
  canRedo: boolean;
}
```

Result behavior:

- Omitted `action` means `list`.
- `list` is read-only, defaults to `origin: "all"`, and should not require
  approval.
- `undo` and `redo` are stack operations. Agent v1 does not support arbitrary
  history jumping.
- `steps` defaults to 1 and should stay small. Initial maximum: 10.
- `undo` and `redo` default to `origin: "agent"` for safety.
- `origin: "agent"` means undo/redo the nearest stack operation whose origin is
  agent, stopping at unsafe dependencies.
- `origin: "user"` means undo/redo the nearest user-origin stack operation and
  usually requires approval.
- `operation_id` is only a guard for the current stack target or a continuous
  stack range. If it would require skipping unrelated later operations, return
  `boundary` and do nothing.
- Undoing user-origin operations requires approval by default.
- Redo follows the redo stack and must fail if a new document mutation has
  invalidated the redo stack.
- If history storage cannot list operations yet, implement `undo` and `redo`
  first but return a clear `boundary` for `list`.

## TypeScript Parser, Preview, and Validation

Electron main owns the complete outliner mutation pipeline. The public pi-mono
tool definitions should stay thin: normalize arguments, call the TypeScript tool
gateway, and wrap gateway responses in `ToolResult`. The gateway may call
in-process TypeScript core services directly today; if the document core moves
behind another runtime boundary later, the public tool contract should not
change.

### Parser modules

Expected TypeScript modules:

```txt
lin_outline_parser
lin_outline_serializer
lin_outline_resolver
lin_mutation_planner
lin_tool_preview
lin_tool_validation
```

Core responsibilities:

```ts
parseOutline(input: string): OutlineDocument
serializeOutline(state: DocumentState, nodeId: string, opts: SerializeOptions): SerializedOutline
resolveOutline(ast: OutlineDocument, state: DocumentState, policy: ResolvePolicy): ResolvedOutline
buildMutationPlan(resolved: ResolvedOutline, context: ToolContext): MutationPlan
validatePlan(plan: MutationPlan, state: DocumentState): ValidationReport
renderPreview(plan: MutationPlan, state: DocumentState): ToolPreview
applyPlan(plan: MutationPlan, state: DocumentState): OperationResult
```

`SerializedOutline` contains annotated model-facing text. `%%node:id%%` markers
are protocol metadata and are stripped before writing node content.

```ts
interface SerializedOutline {
  text: string;
  revision: string;
}
```

The parser accepts `%%node:id%%` only at the start of an outline line after
`- `. For field values written on the same line as a field header, it also
accepts an inline value marker after `::`. `node_create` rejects these markers;
`node_edit` uses them to map existing nodes, fields, and field values.

### `node_edit` flow

Content edits use this sequence:

```txt
load current node state
  -> serialize current annotated outline
  -> check expected_revision when provided
  -> replace old_string with new_string
  -> parse the whole replacement result
  -> validate annotated ids are unique, current, and inside the edited subtree
  -> resolve tags, fields, refs, dates, search/view directives
  -> build MutationPlan using annotated ids only for existing-node identity
  -> validate MutationPlan
  -> render preview
  -> wait for approval when required
  -> apply MutationPlan as one transaction and one undo group
```

`old_string` matching rules:

- `old_string === "*"` replaces the whole annotated outline for `node_id`.
- Otherwise, `old_string` must match exactly once.
- Zero matches means the agent is using stale context and should call
  `node_read` again.
- Multiple matches means the agent should include more surrounding context or
  edit the child directly by node id.
- Matching is byte-exact against the annotated outline string returned by
  `node_read`, after normalizing line endings to `\n`.

Identity rules:

- The root of a full-outline replacement maps to the `node_id` argument.
- If the root line carries `%%node:id%%`, that id must match the `node_id`
  argument.
- Existing marked lines keep identity through their marker.
- Unmarked lines are treated as newly created content.
- Removed marked lines are moved to Trash; they are not permanently deleted.
- Reordered marked lines are moved to the new order.

### Mutation plan

`MutationPlan` is internal. It is the only object that can be applied to
document state.

```ts
type MutationOp =
  | 'createNode'
  | 'updateNodeContent'
  | 'updateNodeDescription'
  | 'setChecked'
  | 'applyTag'
  | 'removeTag'
  | 'createFieldEntry'
  | 'setFieldValues'
  | 'clearField'
  | 'createReference'
  | 'replaceWithReference'
  | 'moveNode'
  | 'mergeNodes'
  | 'redirectReferences'
  | 'trashNode'
  | 'restoreNode'
  | 'updateSearchConfig'
  | 'updateViewConfig';
```

Planning must be deterministic. If the same current state and same tool
arguments are provided, the plan and preview should be identical.

### Preview data

Every mutating node tool can return a preview before apply.

```ts
interface ToolPreview {
  summary: string;
  creates: Array<{ title: string; parentId: string; kind: NodeKind }>;
  updates: Array<{
    nodeId: string;
    title: string;
    before?: unknown;
    after?: unknown;
  }>;
  moves: Array<{ nodeId: string; fromParentId: string; toParentId: string }>;
  deletes: Array<{ nodeId: string; title: string; destination: "trash" }>;
  warnings: string[];
  requiresApproval: boolean;
}
```

Preview should be concise in the model-visible response and richer in the UI
details object. Broad deletes, merges, and ambiguous identity preservation must
be called out explicitly.

### Validation rules

TypeScript validation is the security and correctness boundary.

Required checks:

- The workspace/document boundary is valid for every referenced node.
- `parent_id`, `after_id`, `node_id`, `node_ids`, `target_id`, and
  `merge_from_node_ids` exist and are editable.
- `after_id` is a child of `parent_id` when both are provided.
- Moves cannot create cycles and cannot move locked/system nodes.
- Batch move operations are homogeneous and preserve selected-root semantics.
- Merge target and sources are distinct and have no unsafe ancestor/descendant
  relationship.
- Field values match field type constraints.
- Tag and field auto-creation follows the active policy.
- Search/view directives compile to a canonical `SearchQueryExpr`.
- `expected_revision` matches when provided.
- Parser compatibility normalization does not silently change meaning.

Validation should produce structured guidance:

```ts
interface ValidationReport {
  ok: boolean;
  errors: Array<{ code: string; message: string; span?: SourceSpan }>;
  warnings: Array<{ code: string; message: string; span?: SourceSpan }>;
  instructions?: string;
}
```

### Apply rules

- A tool call applies as one transaction.
- A transaction creates one undo group.
- If any op fails, apply nothing.
- Operation history records origin, tool name, summary, affected nodes, and undo
  group id.
- Apply returns fresh revisions for affected root nodes.

## Local File Tools

File tools are for local files under the configured local file root. They must not mutate the outliner
document. The design keeps dedicated tools for each local file role:

- `file_read` inspects file content.
- `file_edit` applies exact replacements.
- `file_write` creates files or rewrites already-read files.
- `file_glob` lists matching files.
- `file_grep` searches file content.

The model-facing descriptions, parameters, and `data` payloads should stay as
close to the proven local-tool shape as possible. Lin keeps lower snake case
names and wraps the payload in the common `ToolResult` envelope, but should not
invent a second filesystem protocol.

For local tools, the model-facing descriptions should intentionally follow the
same operational habits: use dedicated file/search tools before `bash`, read
before edit/write, use exact string replacement, and background long-running
commands through the tool parameter instead of shell syntax.

The important design rule is that `bash` is not the filesystem API. Agents
should use dedicated tools for reading, editing, writing, listing, and searching
files, and reserve `bash` for commands that actually need a shell.

Path rules:

- Concrete file tools use `file_path`.
- Search tools use `path` as an optional search root.
- Model-facing `file_path` input values should be absolute paths. Search outputs
  such as `file_glob.filenames` and `file_grep.filenames` are local-root-relative
  to save tokens and keep path output compact.
- TypeScript must enforce the configured local file root unless the user explicitly
  grants a broader root.

## Per-Turn Context And Attachments

Dynamic context should be sent with the latest user turn, not baked into the
stable system prompt. This follows the agent runtime pattern:

- Stable identity, behavior, and tool policy live in the system prompt.
- Turn-specific state lives in one or more leading text parts wrapped in
  `<system-reminder>...</system-reminder>`.
- The renderer hides these reminder parts from the transcript, but debug panels
  show them under the request context.
- Current outliner context is a reminder part. Today node id is included because
  `node_create` defaults to today.
- Uploaded files, folders, and images are represented in model-facing user text
  as `[[file:<label>^<path>]]` markers. The path is rewritten to the
  materialized local-root path when the original path is outside the agent local
  root.
- Attachment payloads are runtime transport state, not the normal model-visible
  resource index. Historical `<user-attachments>` markers may still be parsed
  for replay, but new normal turns should rely on file markers.
- Uploaded images remain inline image blocks in addition to their file marker.
  The inline part uses pi-ai's native `ImageContent` contract:
  `{ type: "image", data: base64, mimeType }`.
- Inline uploaded images are limited to provider-safe pi-mono/coding-agent
  formats (`image/jpeg`, `image/png`, `image/gif`, `image/webp`). Large static
  images should be resized before sending so the base64 payload stays under the
  same 4.5 MB inline-image budget used by pi-mono's coding-agent.
- Attachments without a native local path are staged under the agent local file
  root and then sent as file markers. Runtime still accepts inline text
  attachments for historical events.

### `file_read`

Read a file with bounded output. This is the only tool that should inspect file
contents before an edit.

Parameters:

```ts
interface FileReadParams {
  file_path: string;
  offset?: number; // one-based starting line number, default 1
  limit?: number;  // max lines, default 2000
  pages?: string;  // PDF page selector, for example "1-3" or "7"
}
```

Return data:

```ts
type FileReadData =
  | FileReadTextData
  | FileReadImageData
  | FileReadPdfPartsData
  | FileReadNotebookData
  | FileReadUnchangedData;

interface FileReadTextData {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
}

interface FileReadImageData {
  type: "image";
  file: {
    filePath: string;
    base64: string;
    type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    originalSize: number;
    dimensions?: {
      width: number;
      height: number;
    };
  };
}

interface FileReadPdfPartsData {
  type: "parts";
  file: {
    filePath: string;
    originalSize: number;
    pages: {
      firstPage: number;
      lastPage: number;
    };
    extractedText?: {
      chars: number;
      truncated: boolean;
    };
    count: number;
    outputDir: string;
  };
}

interface FileReadNotebookData {
  type: "notebook";
  file: {
    filePath: string;
    cells: Array<{
      cellType: "code" | "markdown" | "raw" | "unknown";
      source: string;
      outputs?: string[];
      executionCount?: number | null;
    }>;
    content: string;
    totalCells: number;
    originalSize: number;
  };
}

interface FileReadUnchangedData {
  type: "file_unchanged";
  file: {
    filePath: string;
  };
}
```

Result behavior:

- Reading directories should fail. Use `file_glob` for file discovery, or
  `bash` with `ls` only when directory metadata is required.
- Large text files are paginated with `offset` and `limit`.
- Image reads return dimensions when they can be determined, attach the image
  block for the model to inspect, and omit base64 from the model-visible JSON so
  text output stays compact.
- PDF reads support `pages` ranges such as `"3"` and `"1-5"`, with a
  maximum of 20 pages per request. PDFs over 10 pages require an explicit range.
  The implementation uses the local page-extraction path: `pdfinfo` determines
  page count, `pdftoppm` renders selected pages as JPEGs, and those page images
  are attached to the tool result for the model. If `pdftotext` is available and
  the selected pages contain embedded text, that extracted text is attached as a
  text part before the page images. Scanned PDFs therefore still work through
  images, while text PDFs remain searchable and token-efficient.
- Lin currently does not send native PDF document blocks because `pi-agent-core`
  exposes text/image tool-result content only. If pi-ai adds document content,
  small PDFs can adopt a `type: "pdf"` base64 document-block path.
- Notebook reads parse `.ipynb` cells and outputs into a compact text rendering
  plus structured cell metadata.
- Binary files should return a typed result only when Lin supports the media
  type; otherwise return a recoverable error.
- Successful reads update a per-run file freshness record used by `file_edit`
  and `file_write`.

### `file_glob`

Find files by path pattern. Use this for file discovery by name or extension.

Parameters:

```ts
interface FileGlobParams {
  pattern: string; // for example "**/*.rs" or "src/**/*.ts"
  path?: string;   // optional absolute search root, default local file root
}
```

Return data:

```ts
interface FileGlobData {
  durationMs: number;
  numFiles: number;
  filenames: string[];
  truncated: boolean;
}
```

Result behavior:

- Results should be sorted by modified time, newest first.
- Returned filenames are local-root-relative, matching `file_grep` and saving
  model tokens.
- TypeScript should cap result count and set `truncated` when needed.
- Use `file_grep`, not `file_glob`, when the task is content search.

### `file_grep`

Search file contents through ripgrep. Use this instead of running `grep`, `rg`,
or similar commands through `bash`.

Parameters:

```ts
interface FileGrepParams {
  pattern: string; // regular expression
  path?: string;   // file or directory root, default local file root
  glob?: string;   // include filter, for example "**/*.rs"
  output_mode?: "content" | "files_with_matches" | "count"; // default files_with_matches
  "-B"?: number;
  "-A"?: number;
  "-C"?: number;
  context?: number;
  "-n"?: boolean;
  "-i"?: boolean;
  type?: string;       // optional language/file type filter
  head_limit?: number; // max returned lines/items; 0 means unlimited within hard caps
  offset?: number;
  multiline?: boolean;
}
```

Return data:

```ts
interface FileGrepData {
  mode?: "content" | "files_with_matches" | "count";
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  appliedLimit?: number;
  appliedOffset?: number;
}
```

Result behavior:

- Default to `files_with_matches` so broad searches stay cheap.
- Results paths are local-root-relative to reduce tokens and keep
  output.
- `content` mode should include file paths and line numbers when useful.
- Multiline search should be explicit because it is more expensive.
- TypeScript must enforce hard output caps even when `head_limit` is `0`. If Lin needs
  to expose hard-cap truncation beyond `appliedLimit`, put it in the common
  `ToolResult.metrics`, not inside `FileGrepData`.

### `file_edit`

Apply exact string replacements. This is intentionally not a mini patch
language.

Parameters:

```ts
interface FileEditParams {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
```

Return data:

```ts
interface FileEditData {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;
  structuredPatch: Hunk[];
  userModified: boolean;
  replaceAll: boolean;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

```

Result behavior:

- The agent must call `file_read` on the file before `file_edit`.
- `old_string` must match the file exactly.
- If `old_string` appears multiple times, fail unless `replace_all` is true.
- If the file changed after the last `file_read`, fail with `userModified` and
  guidance to read again.
- Return `unchanged` when the requested replacement is already reflected in the
  file.
- Return a compact local hunk around the changed region, not a whole-file
  before/after patch, so small edits stay cheap for the model.

### `file_write`

Create a new file or rewrite a whole file. Prefer `file_edit` for modifying an
existing file.

Parameters:

```ts
interface FileWriteParams {
  file_path: string;
  content: string;
}
```

Return data:

```ts
interface FileWriteData {
  type: "create" | "update";
  filePath: string;
  content: string;
  structuredPatch: Hunk[];
  originalFile: string | null;
}
```

Result behavior:

- Creating a new file does not require a prior `file_read`.
- Updating an existing file requires a prior `file_read` freshness record.
- Overwriting a file should require approval.
- Do not use `file_write` to append small changes; use `file_edit`.

## Shell Tools

### `bash`

Run a local command. It is for shell execution, not file reading, file editing,
or content search.

Parameters:

```ts
interface BashParams {
  command: string;
  description?: string;
  timeout?: number; // milliseconds
  run_in_background?: boolean;
  dangerouslyDisableSandbox?: boolean; // optional, hidden or approval-gated
}
```

Return data:

```ts
interface BashData {
  stdout: string;
  stderr: string;
  rawOutputPath?: string;
  interrupted: boolean;
  isImage?: boolean;
  backgroundTaskId?: string;
  backgroundedByUser?: boolean;
  assistantAutoBackgrounded?: boolean;
  dangerouslyDisableSandbox?: boolean;
  returnCodeInterpretation?: string;
  noOutputExpected?: boolean;
  structuredContent?: unknown[];
  persistedOutputPath?: string;
  persistedOutputSize?: number;
  command?: string;
  taskStatus?: "running" | "completed" | "failed" | "stopped";
  exitCode?: number | null;
  startedAt?: string;
  completedAt?: string;
}
```

Result behavior:

- Commands run in the local file root by default. Lin should not expose a
  model-facing `cwd` parameter initially; the agent can use shell syntax when a
  command truly needs another directory.
- Long-running commands should use `run_in_background: true` and return
  `backgroundTaskId`. The agent should not append `&`.
- Foreground commands that outlive Lin's blocking budget may be auto-backgrounded
  and return `assistantAutoBackgrounded: true` with a task output file path.
- Output must be bounded. Large output should be persisted and referenced by
  `persistedOutputPath`, which the agent can read with `file_read`.
- Completion of a background command should be surfaced through the agent
  runtime event stream with the same output path. Do not add a polling-first
  `TaskOutput` equivalent unless real usage proves `file_read` is insufficient.
- Risky commands require approval.
- Non-zero command exit is represented through `stdout`, `stderr`, `exitCode`,
  and optional `returnCodeInterpretation`.
- Do not use `bash` to read, edit, write, glob, or grep files when the dedicated
  file tool fits the task.

### `task_stop`

Stop a background command created by `bash`. It is not a generic process
manager and does not provide status/read/wait operations.

Parameters:

```ts
interface TaskStopParams {
  task_id: string;
}
```

Return data:

```ts
interface TaskStopData {
  message: string;
  task_id: string;
  task_type: string;
  command?: string;
  status: "stopped";
  outputPath: string;
}
```

Result behavior:

- Only stop tasks created by Lin's own `bash` tool.
- If a background task finishes, Lin should surface completion through the agent
  runtime event stream; the agent should not need a polling tool.
- If the output is too large, `bash` should persist it and return a path that
  can be read with `file_read`.

## Web Tools

Web tools are read-only retrieval tools. Follow lin-agent's split: `web_search`
discovers sources, `web_fetch` reads one known URL. Do not merge them into a
generic `web` tool, and do not route routine web reads through `bash`.

They should be disabled or approval-gated if the workspace is configured for
offline/private mode. Permission scope is host-based:

- `web_fetch`: `Web(<url host>)`
- `web_search`: `Web(<site host>)` when `site` is set, otherwise
  `Web(<search provider host>)`

Shared behavior:

- Tools are `isReadOnly: true`, `isConcurrencySafe: true`, and should use a
  `maxResultSizeChars` budget around `100_000`.
- Prefer an embedded browser/session-backed fetch path when available so normal
  user cookies and proxy settings work. A TypeScript HTTP client is acceptable for v1
  if browser session plumbing is not ready.
- Return content separately from telemetry. The `data.content` or
  `data.results` fields carry what the model needs; status, bytes, final URL,
  duration, hints, and pagination metadata stay in structured fields.
- Hints are successful tool results, not thrown errors. They tell the agent what
  cannot be completed automatically.
- Fatal validation, network, extraction, and parse failures return
  `status: "error"` with a categorical `error.code`.

Shared hint and error types:

```ts
type WebToolHint =
  | {
      type: "login_required";
      origin: string;
      detectedVia: "url_redirect" | "selector_match" | "title_keyword" | "http_401";
    }
  | { type: "needs_browser"; reason: "spa_shell" | "cloudflare" | "http_error" }
  | { type: "search_blocked"; reason: "captcha" | "rate_limit" | "unusual_traffic"; origin: string }
  | { type: "redirected_host"; originalUrl: string; finalUrl: string; finalHost: string };

type WebErrorCode =
  | "invalid_args"
  | "invalid_url"
  | "unsupported_scheme"
  | "permission_denied"
  | "offline_mode"
  | "no_session"
  | "network_error"
  | "timeout"
  | "extraction_failed"
  | "parse_failed"
  | "binary_unsupported"
  | "rate_limited"
  | "aborted";
```

### `web_search`

Search the web for current external information. Use this when the agent does
not already have a specific URL. Do not use it as a round trip before
`web_fetch` when the URL is already known.

Parameters:

```ts
interface WebSearchParams {
  query: string; // 1..500 chars. Natural language and search operators are allowed.
  limit?: number; // default 10, max 20
  site?: string; // optional host; appended as `site:<host>`
  recency_days?: number; // optional provider hint for fresh results
}
```

Return data:

```ts
interface WebSearchData {
  query: string;
  effectiveQuery: string;
  provider: "google" | "provider" | "custom";
  finalUrl?: string;
  resultCount: number;
  totalResults?: number;
  truncated: boolean;
  durationMs?: number;
  hint?: WebToolHint;
  results: WebSearchResult[];
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
}
```

Result behavior:

- `site` is a convenience parameter for a single host. For multiple hosts, the
  agent should issue multiple searches or put explicit search syntax in
  `query`.
- `recency_days` is a hint, not a hard guarantee. If the backend cannot enforce
  it, return results and add a warning.
- CAPTCHA, unusual traffic, or search-provider block pages return
  `status: "success"` with `data.hint.type: "search_blocked"`, not retries in a
  loop.
- Empty results return `status: "success"` with `resultCount: 0` and a
  `instructions` suggesting a broader query.
- The model-visible result should make sources easy to cite. If the adapter
  renders a compact text view in addition to JSON, use a short numbered source
  list and include a reminder that answers using search results must cite
  sources with markdown links.

Example success data:

```json
{
  "query": "loro crdt move operation",
  "effectiveQuery": "loro crdt move operation site:loro.dev",
  "provider": "google",
  "finalUrl": "https://www.google.com/search?q=loro+crdt+move+operation+site%3Aloro.dev",
  "resultCount": 2,
  "truncated": false,
  "results": [
    {
      "title": "Loro Docs",
      "url": "https://www.loro.dev/docs/...",
      "snippet": "Loro supports move operations for tree structures..."
    }
  ]
}
```

### `web_fetch`

Fetch and read a known URL. It returns extracted content directly, not a
secondary-model summary. If the page is large, use read pagination or `query`
mode to get relevant snippets.

Parameters:

```ts
interface WebFetchParams {
  url: string; // absolute http(s) URL, max 2000 chars; http may be upgraded to https
  format?: "markdown" | "text" | "raw" | "metadata"; // default markdown
  offset?: number; // read mode character offset, default 0
  max_chars?: number; // read mode character cap, default 30000

  // Find mode. When set, return matching snippets instead of the full page.
  query?: string;
  context?: number; // chars before/after each match, default 500
  head_limit?: number; // max matches, default 10
  match_offset?: number; // skip first N matches, default 0
  case_insensitive?: boolean; // default true
}
```

Return data:

```ts
interface WebFetchData {
  url: string;
  finalUrl: string;
  statusCode: number;
  statusText?: string;
  contentType?: string;
  byteLength?: number;
  durationMs?: number;
  mode: "read" | "find" | "metadata";
  format: "markdown" | "text" | "raw" | "metadata";
  title?: string;
  content?: string;
  metadata?: WebPageMetadata;
  totalChars?: number;
  returnedChars?: number;
  nextOffset?: number;
  matches?: WebFetchMatch[];
  totalMatches?: number;
  returnedMatches?: number;
  nextMatchOffset?: number;
  truncated: boolean;
  hint?: WebToolHint;
}

interface WebPageMetadata {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  siteName?: string;
  language?: string;
  headings?: string[];
  links?: Array<{ text: string; url: string }>;
}

interface WebFetchMatch {
  index: number;
  start: number;
  end: number;
  snippetStart: number;
  snippetEnd: number;
  snippet: string;
}
```

Result behavior:

- `format: "markdown"` converts HTML to readable markdown. Plain text and JSON
  may be returned verbatim.
- `format: "metadata"` returns only page metadata and selected links/headings;
  it should not return full body content.
- `query` activates find mode. It searches the extracted content and returns
  snippets with offsets, similar to `file_grep` over one fetched URL.
- `offset`/`max_chars` page full content in read mode.
  `match_offset`/`head_limit` page matches in find mode.
- Same-host redirects may be followed transparently. Cross-host redirects should
  return `data.hint.type: "redirected_host"` unless the final host is already
  permitted; the agent can then call `web_fetch` on `finalUrl`.
- Authentication walls return `login_required`; JavaScript-only shells,
  Cloudflare, or HTTP errors that might work in a live browser return
  `needs_browser`.
- Binary content returns `binary_unsupported` unless Lin implements a binary
  persistence path. If binary persistence is added, return a file path in
  `data.metadata` and keep model-visible text short.

Example read result data:

```json
{
  "url": "https://example.com/article",
  "finalUrl": "https://example.com/article",
  "statusCode": 200,
  "contentType": "text/html; charset=utf-8",
  "mode": "read",
  "format": "markdown",
  "title": "Example Article",
  "content": "# Example Article\n\n...",
  "totalChars": 45210,
  "returnedChars": 30000,
  "nextOffset": 30000,
  "truncated": true
}
```

## Conversation Tools

### `past_chats`

Canonical contract lives in [`../plans/agent-past-chats.md`](../plans/agent-past-chats.md).
The plan supersedes any earlier sketch of this tool. One tool, three modes
(`recent`/`search`/`read`) selected by parameters, internally backed by the
existing event store, user-message/search indexes, and visible transcript
filtering. Move the final stable contract into this spec once the
implementation PR lands.

## Self-Maintenance Controls

Canonical contracts for `runtime_status`, the cc-2.1-style `config` tool,
doctor workflow, and controlled skill-maintenance workflows live in
[`../plans/agent-self-modification.md`](../plans/agent-self-modification.md).

Runtime control tools are not file tools:

- `runtime_status` and doctor diagnostics are read-only and must redact secrets.
- `config` reads when `value` is omitted and writes when `value` is present,
  matching cc-2.1's small `ConfigTool` shape.
- `config` writes are ask-gated, whitelisted, versioned changes through
  runtime-owned write paths. Review/approval cards are UI around the permission
  request, not a separate model-facing tool.
- The agent must not use `file_edit`, `file_write`, or `bash` to mutate provider
  settings, permission config, hook config, skill registry metadata, or
  last-known-good recovery state.
- Skill maintenance should not add a separate model-facing CRUD tool family in
  v1. It should follow cc-2.1's approach: `/skillify` or natural-language skill
  edit workflows produce/review content, then use existing `file_write` or
  `file_edit`.
- The file-tool gateway must classify writes under `.agents/skills/**` as
  skill-content writes instead of generic document edits, attaching permission,
  validation, provenance, snapshot, rollback, and event-log behavior.

## Mapping to Current Lin Commands

The public tools should compile down to TypeScript-backed commands. Current command
coverage maps as follows:

| Public tool | Current or needed backend capability |
|---|---|
| `node_search` | Temporary/saved search node parser compiled to full-text, tag, field, link-relationship, and view metadata. |
| `node_read` | `get_projection`, `backlinks`, annotated outline serialization, computed field and child summaries. |
| `node_create` | `create_node`, `create_tag`, `create_field_def`, `create_inline_field`, `set_node_checkbox_visible`, `add_reference`, `create_search_node`, duplicate support. |
| `node_edit` | Canonical outline exact replacement compiled to `apply_node_text_patch`, `set_node_checkbox_visible`, `toggle_done`, tag/field mutations, `move_node`, `trash_node`, `set_reference_target`, `replace_node_with_reference`, and `set_search_node`. |
| `node_delete` | `trash_node`, `batch_trash_nodes`, `restore_node`; permanent delete is not exposed to agent v1. |
| `operation_history` | Loro UndoManager-backed `undo`/`redo` plus operation journal listing with origin metadata. |
| `file_read` | Implemented TypeScript file read command with path normalization, text pagination, image content/dimensions, PDF page rendering, notebook parsing, and freshness tracking. |
| `file_glob` | Implemented TypeScript glob command under allowed roots with local-root-relative output paths. |
| `file_grep` | Implemented ripgrep-backed search command under allowed roots with relative paths, output modes, pagination, and output caps. |
| `file_edit` | Implemented TypeScript exact-replacement command with read-before-edit freshness checks. |
| `file_write` | Implemented TypeScript create/rewrite command with read-before-write freshness checks for existing files. |
| `bash` | Implemented TypeScript command runner with timeout, output caps, background task support, and output persistence. |
| `task_stop` | Implemented TypeScript background task stop command scoped to Lin-created bash tasks. |
| `web_search` | Needed web search adapter: provider-backed search or embedded-browser SERP extraction, host permission scope, rate limiting, structured hints. |
| `web_fetch` | Needed URL fetch adapter: TypeScript HTTP and/or embedded browser session fetch, HTML-to-markdown extraction, pagination, find mode, structured hints. |

Lin should prefer adding semantic TypeScript core commands where the current command
set is too UI-shaped. For example, semantic target/source merge is better for
agents than only `merge_node_into_previous`.

## Approval Policy

The permission **policy** — the allow/ask/deny model, platform hard blocks, the
bash classifier, ask resolution, sensitive-data redlines, the global store, and
events — is specified in `agent-tool-permissions.md`. This section only
classifies each tool as read-only vs mutating (the input that policy acts on).

Read-only tools run immediately when their permission scope is already allowed:

- `node_search`
- `node_read`
- `file_read`
- `file_glob`
- `file_grep`
- `past_chats`
- `operation_history(action: "list")`

Web tools are also read-only, but may require host or offline-mode approval:

- `web_search`
- `web_fetch`

Mutating tools may require approval depending on risk:

- `node_create`
- `node_edit`
- `node_delete`
- `operation_history(action: "undo" | "redo")`
- `file_edit`
- `file_write`
- `bash`
- `task_stop`

How risk maps to allow / ask / deny (broad node/file edits, user-origin
undo/redo, risky shell, exfiltration redlines, permissive-mode behavior) is owned
by `agent-tool-permissions.md`.

## Implementation Notes

- Tool schemas live beside the Electron main-process pi-mono runtime, but
  validation and mutation semantics live in the TypeScript tool gateway.
- The pi-mono tool adapter should remain thin: normalize parameters, invoke the
  gateway, and convert gateway responses into `ToolResult`.
- TypeScript should own outliner parsing, tag resolution, field resolution, operation
  grouping, permissions, and persistence.
- All document mutations should create an operation history entry with origin,
  summary, affected nodes, and undo group id.
- Active UI context is injected every user turn and should not be fetched with a
  tool.
- Large tool outputs must be paginated or truncated with `metrics.truncated`.
- Tool results should be stable enough to persist in conversation history.
