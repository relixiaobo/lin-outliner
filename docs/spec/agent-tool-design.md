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
- Put outliner semantics in Rust-backed tools, not in the model prompt.
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
- Do not expose internal Rust command names as the public agent API.
- Do not make file, bash, or web tools responsible for outliner mutations.

## Tool Registry

### P0 Tools

These tools are required for the first useful local agent.

| Tool | Kind | Mutates | Approval | Purpose |
|---|---|---:|---|---|
| `node_search` | outliner | No | No | Search nodes by text, tag, field, backlink, subtree, date, or sort rules. |
| `node_read` | outliner | No | No | Read node raw type/data, fields, and bounded children. |
| `node_create` | outliner | Yes | Usually yes | Create content trees, references, search nodes, or duplicates. |
| `node_edit` | outliner | Yes | Usually yes | Incrementally edit existing nodes: text, tag, field, done state, move, merge, data. |
| `node_delete` | outliner | Yes | Usually yes | Trash or restore one or more nodes. |
| `operation_history` | outliner | Yes for undo/redo | Usually yes | Inspect, undo, or redo user and agent operations. |
| `file_read` | local | No | Usually no | Read workspace files with bounded output. |
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
- Local file tools should mirror cc-2.1's `Read`, `Edit`, `Write`, `Glob`,
  and `Grep` roles, while keeping Lin's lower snake case names.
- Do not use a generic `node_batch`; batch capability belongs inside the
  relevant tool parameters.

## Common Result Envelope

Every tool returns JSON in both the model-visible text result and a structured
details object. The text result should be a pretty-printed JSON serialization of
the same object, so weaker models can still inspect the result.

```ts
interface ToolResult<TData = unknown> {
  ok: boolean;
  tool: string;
  version: 1;
  status: "success" | "partial" | "unchanged" | "denied" | "error";
  data?: TData;
  error?: ToolError;
  operation?: OperationResult;
  boundary?: string;
  nextStep?: string;
  fallback?: string;
  hint?: string;
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

Guidance fields are first-class:

- `boundary`: what the tool intentionally did not do.
- `nextStep`: the recommended next tool call or action.
- `fallback`: an alternative if the recommended path fails.
- `hint`: short agent-facing correction.

Use guidance fields for unknown tags, unresolved fields, permission denials,
truncation, no-op updates, and ambiguous targets.

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
  "nextStep": "Use node_search or node_read on the parent context to find the correct node id.",
  "hint": "The node id may be stale after a delete, restore, or undo."
}
```

## Nodex Node Tool Contract

Node tools should follow nodex's model-facing descriptions, parameter names, and
parser behavior. Lin keeps the shared `ToolResult` envelope and Rust-backed
implementation, but the model should learn the same compact outliner surface:

- `node_search`
- `node_read`
- `node_create`
- `node_edit`
- `node_delete`

`operation_history` is a Lin extension over nodex's AI-only `undo` tool. Keep it
separate from the `node_*` tools.

## Outliner Text Parser Contract

`node_create.text` and `node_edit.text` use nodex's outliner text parser shape.
The parser is part of the tool contract, not a prompt convention. TypeScript may
validate shape, but Rust must own parsing and application semantics. Lin
implementation names should use neutral terms such as `outliner_text_parser`,
not external product names.

Parser patterns:

```ts
const REFERENCE_PATTERN = /\[\[([^\]^]+)\^([^\]]+)\]\]/g;
const EXACT_REFERENCE_PATTERN = /^\[\[([^\]^]+)\^([^\]]+)\]\]$/;
const CHECKBOX_PATTERN = /^\[(X| )\](?:\s+(.*))?$/;
const FIELD_PATTERN = /^([^:\n]+?)::(?:\s*(.*))?$/;
const TAG_PATTERN = /(^|\s)#([^\s#[\]]+)/g;
const BULLET_PREFIX = "- ";
```

Parsed AST:

```ts
interface ParsedOutlinerTextValue {
  text: string;
  inlineRefs: InlineRefEntry[];
  targetId?: string;
}

interface ParsedOutlinerTextField {
  name: string;
  values: ParsedOutlinerTextValue[];
  clear: boolean;
}

interface ParsedOutlinerTextNode {
  name: string;
  inlineRefs: InlineRefEntry[];
  tags: string[];
  checked: boolean | null;
  targetId?: string;
  fields: ParsedOutlinerTextField[];
  children: ParsedOutlinerTextNode[];
}

interface InlineRefEntry {
  offset: number;
  targetNodeId: string;
  displayName?: string;
}
```

Agent-facing parser rules:

- Input is multi-line plain text, not Markdown.
- Each non-empty line is a node, field, or field value.
- Every agent-generated line must start with `- ` after indentation.
- Indentation must be exactly 2 spaces per level. Invalid indentation is an
  error.
- The first line is the root node, unless it is a `Field::` line.
- Unindented lines after the first line may only be root metadata: tags,
  checkbox state, or fields. Plain unindented child content is an error.
- `#tagName` extracts a tag display name and removes it from node text.
- `[X]` sets checked to true. `[ ]` sets checked to false.
- `Field:: value` creates a single field value.
- `Field::` with no inline value creates a clear-field intent and opens a value
  block. If indented values follow, the field is no longer a clear and those
  lines become field values.
- A whole-line `[[Display^nodeId]]` creates a reference node or reference field
  value.
- Inline `[[Display^nodeId]]` creates an inline reference and replaces that text
  with `\uFFFC` in the parsed text while recording the reference offset.
- Max application depth follows nodex's parser behavior: 3 child levels.

Agent-facing supported constructs:

Plain tree:

```text
- Project
  - Task A
    - Subtask A1
  - Task B
```

Tags and checkbox state:

```text
- [ ] Publish release notes #task #work
```

Single-value fields:

```text
- Weekly review #meeting
  - Date:: 2026-05-13
  - Location:: Room A
```

Multi-value fields:

```text
- Weekly review #meeting
  - Attendees::
    - Alice
    - [[Bob^node_bob]]
```

Children mixed with fields:

```text
- Weekly review #meeting
  - Date:: 2026-05-13
  - [X] Publish notes #task
  - Notes
    - Follow up with [[Project Alpha^node_project_alpha]]
```

References:

```text
- See [[Project Alpha^node_project_alpha]]
  - Related:: [[Weekly review^node_weekly_review]]
  - [[Task A^node_task_a]]
```

Metadata-only edit without renaming the target node:

```text
- #task
- Status:: Done
- [X]
```

Clear a field in `node_edit`:

```text
- Assignees::
```

Runtime compatibility note:

- The model-facing tool description should expose only the format above.
- The runtime may accept missing bullet prefixes, copied outliner list text, or
  editor-specific indentation variants by normalizing them before parsing.
- Compatibility normalization is an implementation detail. It should not be
  described in the tool schema, because multiple accepted input forms make the
  agent less predictable.

### Tag Resolution

Tags are addressed by display name in text input and search rules.

Resolution order:

1. Normalize by trimming, removing a leading `#`, and case-folding.
2. Exact display name match.
3. Optional fuzzy match above a conservative threshold.
4. If allowed by policy, auto-create a tag definition.
5. Otherwise report `unresolvedTags`.

Nodex behavior: `node_create` and `node_edit` both auto-create missing tags from
`#tagName` input.

### Field Resolution

Fields are addressed by display name.

Resolution order:

1. Read fields available from the node's applied tags.
2. Exact display name match.
3. Optional fuzzy match above a conservative threshold.
4. If the node has at least one tag, create a field definition under the first
   tag. Infer field type from field name/value.
5. Otherwise report `unresolvedFields`.

Field values are represented as child value nodes under the field entry. Options
fields should resolve or auto-create option nodes, then store value nodes with
`targetId` pointing at the selected option.

When nodex auto-creates a field definition, it infers field type from the field
name and sample value:

- `date`, `deadline`, `due`, `start`, `end`, etc. -> `date`
- `url`, `link`, `website`, or `http(s)://` values -> `url`
- `email` or email-shaped values -> `email`
- `count`, `number`, `amount`, `price`, `qty`, etc. -> `number`
- otherwise -> `options`

Shared outliner type names used below:

```ts
type NodeKind =
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
  | "queryCondition";

type FieldType =
  | "plain"
  | "options"
  | "options_from_supertag"
  | "date"
  | "number"
  | "password"
  | "formula"
  | "url"
  | "email"
  | "checkbox"
  | "boolean"
  | "color";
```

## Outliner Tools

### `node_search`

Search the knowledge graph. Supports text search, tag filtering, field value
filtering, backlink lookup, date range, subtree scoping, and sorting. Think of
it as Grep for the knowledge graph.

All search conditions go inside `rules`. Execution parameters stay at the top
level.

Parameters:

```ts
interface SearchRules {
  query?: string; // Text filter on node name and description.
  searchTags?: string[]; // Tag display names. AND logic.
  fields?: Record<string, string>; // Field value filters by display name.
  linkedTo?: string; // Node ID: find nodes that reference this node.
  scopeId?: string; // Node ID: restrict to this node and descendants.
  parentId?: string; // Deprecated alias for scopeId.
  after?: string; // Creation date lower bound, YYYY-MM-DD inclusive.
  before?: string; // Creation date upper bound, YYYY-MM-DD inclusive.
  sortBy?: string; // "field" or "field:order"; fields relevance, created, modified, name, refCount.
}

interface NodeSearchParams {
  rules?: SearchRules;
  limit?: number;  // default 20, max 50
  offset?: number; // default 0
  count?: boolean; // if true, return only total and guidance
}
```

Return data:

```ts
interface NodeSearchData {
  total: number;
  offset?: number;
  limit?: number;
  items?: NodeSearchItem[];
  unresolvedTags?: string[];
  unresolvedFilters?: string[];
}

interface NodeSearchItem {
  id: string;
  name: string;
  tags: string[];
  snippet: string;
  createdAt: string;
  parentName: string;
  fields: Record<string, string>;
}
```

Result behavior:

- Text search is fuzzy and CJK-aware.
- `searchTags` are AND filters. If any tag name is unknown, return zero results
  with guidance.
- Unknown field names are ignored and reported as `unresolvedFilters`.
- `linkedTo` should search tree references, inline references, and field value
  references.
- `scopeId` includes the scope node and all descendants.
- `count: true` returns only `total` plus guidance fields.
- Default sort is relevance when `query` exists, otherwise `modified:desc`.

Example result:

```json
{
  "ok": true,
  "tool": "node_search",
  "version": 1,
  "status": "success",
  "data": {
    "total": 2,
    "offset": 0,
    "limit": 20,
    "items": [
      {
        "id": "node_1",
        "name": "Publish release notes",
        "tags": ["task"],
        "snippet": "Publish release notes",
        "createdAt": "2026-05-12T09:00:00.000Z",
        "parentName": "Today",
        "fields": { "Status": "Todo" }
      }
    ]
  },
  "pagination": { "total": 2, "offset": 0, "limit": 20, "hasMore": false }
}
```

### `node_read`

Read a node's raw type/data, content, fields, and children. Fields show type and
available options. Field entries are returned in the `fields` array, not in
`children`; children only list content nodes and references.

Parameters:

```ts
interface NodeReadParams {
  nodeId?: string; // omit to browse workspace root. Shortcuts: "journal", "schema".
  depth?: number; // 0 = no children, default 1, max 3
  childOffset?: number; // default 0
  childLimit?: number; // default 20, max 50
}
```

Return data:

```ts
interface NodeReadData {
  id: string;
  type: NodeKind | null;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  nodeData: Record<string, unknown>;
  fields: NodeFieldRead[];
  checked: boolean | null;
  parent: { id: string; name: string } | null;
  breadcrumb: string[];
  children: ChildrenPage;
}

interface NodeFieldRead {
  name: string;
  type: string;
  value: string;
  fieldEntryId: string;
  valueNodeId: string | null;
  options?: string[];
}

interface ChildrenPage {
  total: number;
  offset: number;
  limit: number;
  items: NodeChildSummary[];
}

interface NodeChildSummary {
  id: string;
  name: string;
  hasChildren: boolean;
  childCount: number;
  tags: string[];
  checked: boolean | null;
  isReference?: boolean;
  targetId?: string;
  children?: ChildrenPage;
}
```

Result behavior:

- Omitted `nodeId` reads the workspace root.
- `nodeId: "journal"` reads the Journal node.
- `nodeId: "schema"` reads tags and field definitions.
- `depth` is bounded to prevent dumping the entire document.
- If children are truncated, return `total`, `offset`, and `limit` so the agent
  can page with `childOffset`.
- Use `node_read(nodeId: "schema")` before schema operations, then read a tagDef
  node to find fieldDef children before editing field definitions.

### `node_create`

Create nodes in the knowledge graph. There are three modes:

1. Content node: pass `text`.
2. Search node: pass `type: "search"`, `text` as the node name, and `rules`.
3. Duplicate: pass `duplicateId` to deep-copy an existing node. Duplicate mode
   ignores `text`, `type`, and `rules`.

Parameters:

```ts
interface NodeCreateParams {
  type?: "search"; // omit for normal content
  text?: string; // outliner text, or search node name when type="search"
  rules?: SearchRules; // required when type is "search"
  data?: Record<string, unknown>;
  duplicateId?: string;
  parentId?: string; // default: today's journal node
  afterId?: string;
}
```

Return data:

```ts
type NodeCreateData = ContentCreateData | SearchCreateData | DuplicateCreateData;

interface ContentCreateData {
  id: string;
  status: "created";
  parentId: string;
  isReference?: boolean;
  targetId?: string;
  name?: string;
  childrenCreated?: number;
  createdFields?: string[];
  unresolvedFields?: string[];
}

interface SearchCreateData {
  id: string;
  status: "created";
  type: "search";
  name: string;
  parentId: string;
  appliedRuleCount: number;
  rulesApplied?: Record<string, unknown>;
  unresolvedTags?: string[];
  unresolvedFields?: string[];
  ignoredSortBy?: string;
}

interface DuplicateCreateData {
  id: string;
  name: string;
  parentId: string;
  duplicatedFrom: string;
}
```

Result behavior:

- `afterId` resolves insertion location from the sibling's parent. If `parentId`
  is also provided, it must match that sibling parent.
- `#tag` auto-creates the tag if it does not exist.
- Field values only resolve after tags are applied. If a field cannot resolve,
  return `unresolvedFields` and guidance.
- A node with at least one tag may auto-create missing field definitions under
  the first tag, with field type inferred from field name/value.
- Exact reference lines create reference nodes. Inline reference syntax creates
  inline refs in node text or field values.
- `data` is for non-content properties such as `description`, `color`,
  `codeLanguage`, `showCheckbox`, or content-node `type`. It cannot set `id`,
  `name`, `children`, `tags`, or timestamps.
- Search nodes store persistable rules only. Unknown tags/fields are skipped and
  reported. `sortBy: "relevance:*"` is runtime-only and reported as
  `ignoredSortBy`.

Example:

```json
{
  "ok": true,
  "tool": "node_create",
  "version": 1,
  "status": "partial",
  "data": {
    "id": "node_new",
    "status": "created",
    "parentId": "today",
    "childrenCreated": 3,
    "createdFields": ["Status"],
    "unresolvedFields": ["Owner"]
  },
  "operation": {
    "operationId": "op_123",
    "undoGroupId": "undo_123",
    "origin": "agent",
    "action": "node_create",
    "affectedNodeIds": ["node_new"],
    "summary": "Created Weekly review with 3 children"
  },
  "boundary": "Field values only resolve from fields available on the node after tags are applied.",
  "nextStep": "Add a tag that defines Owner, then call node_edit again with Owner:: value.",
  "hint": "Some fields could not be resolved because the node has no matching field definition."
}
```

### `node_edit`

Incrementally modify existing nodes. Only provided parameters are applied.
This is a semantic outliner edit, not a file-style line edit or string
replacement. The agent targets existing content by `nodeId`; the line structure
inside `text` is only a compact way to express node title, metadata, fields, and
new child trees.

Use the single-node form for one target. Use `changes` when several
already-known nodes should be changed together, such as a parent plus children,
or several siblings. `changes` is a string format that the runtime parses into
internal edit patches; the model should not construct an array of patch objects.
This keeps the public tool set compact without introducing a generic
`node_batch` meta-tool.

Parameters:

```ts
type NodeEditParams = SingleNodeEditParams | MultiNodeEditTextParams;

interface SingleNodeEditParams {
  nodeId: string;
  text?: string; // outliner text, incremental add/set semantics
  removeTags?: string[];
  data?: Record<string, unknown>;
  parentId?: string; // Move to this parent.
  afterId?: string;
  mergeFrom?: string;
}

interface MultiNodeEditTextParams {
  changes: string; // multi-node edit text, max 20 target blocks
}
```

Incremental text semantics:

- `text` is not a patch language. Do not use line numbers, `old_string`, or
  `new_string` semantics.
- In `node_create`, `text` describes the full new subtree to create. In
  `node_edit`, `text` is incremental: it changes the target node metadata/title
  and appends new children, but it is not a full snapshot of the existing node.
- Plain first line renames the node.
- Metadata-only first line does not rename the node.
- `#tag` adds a tag.
- `removeTags` removes tags; text syntax cannot remove tags.
- `Field:: value` sets a field.
- `Field::` clears a field.
- `[X]` and `[ ]` set done state.
- Indented nodes append children and never remove existing children.
- To create children without changing the target node, prefer
  `node_create(parentId: nodeId, text: ...)`.
- To edit existing children or siblings together, use `changes` with each
  child's or sibling's `nodeId`; do not address them by line number or display
  text.
- Search node rule editing is not supported. Delete and recreate the search node
  with `node_create(type: "search")`.

Multi-node edit text format:

```text
@task_1
- [X]

@task_2
- Status:: In Progress

@task_3
> move parent=proj_2 after=task_8
```

Format rules:

- Each block starts with `@<nodeId>` on its own line.
- Lines after the header and before the next `@<nodeId>` header apply to that
  target node.
- Outliner text lines use the same agent-facing outliner text format as
  single-node `text`.
- Command lines start with `>` and are parsed by the runtime.
- Supported commands:
  - `> move parent=<nodeId> [after=<nodeId>]`
  - `> remove_tags tag1, tag2`
  - `> merge_from <nodeId>`
  - `> data {"description":"...", "color":"red"}`
- `merge_from` should be the only operation in its block.

Multi-node edit semantics:

- `changes` is a scoped multi-edit mode for the same semantic primitive. It is
  not a generic batch protocol and cannot call `node_create`, `node_delete`,
  `node_search`, or `operation_history`.
- Every block must identify an existing node by `nodeId`.
- Blocks are applied in text order in a single transaction and a single undo
  group.
- Validate all blocks before mutating. If any block is invalid, return an error
  and apply nothing.
- Use `changes` for efficient sibling/child updates, bulk status changes, field
  updates on several selected nodes, or a coordinated move of known nodes.
- Keep `changes` small and reviewable. Initial max: 20 target blocks.

Nodex comparison:

- Nodex `node_edit` accepts one `nodeId` per call.
- That call can still apply multiple changes to the target node: rename, add
  tags, set or clear fields, set checked state, mutate `data`, move position, or
  merge another node.
- Nodex `text` can append a whole new child subtree under the target node.
  Existing children are not removed or replaced.
- Nodex does not edit existing children or siblings by line number. To edit an
  existing child or sibling, the agent must target that node's own `nodeId`.
- Lin's `changes` string is a deliberate extension over nodex for efficient
  multi-node updates while keeping the operation type semantic and bounded.

Relationship to `file_edit`:

- Borrow the safety model: read before non-trivial edits, reject ambiguous
  targets, return a structured before/after result, and group the mutation for
  undo.
- Do not borrow the file mutation model. `file_edit` uses exact
  `old_string` -> `new_string` replacement because files are linear text.
  Outliner edits should use semantic parameters: `nodeId`, `text`, `removeTags`,
  `data`, `parentId`, `afterId`, and `mergeFrom`.

Return data:

```ts
interface NodeEditData {
  status: "updated" | "unchanged";
  mode: "single" | "multi";
  updated?: Array<"name" | "tags" | "checked" | "fields" | "position" | "data">;
  items?: NodeEditItemResult[];
  tags?: string[];
  parentId?: string;
  createdFields?: string[];
  unresolvedFields?: string[];
  merged?: {
    from: string;
    childrenMoved: number;
    tagsMerged: number;
    fieldsMerged: number;
    referencesRedirected: number;
  };
}

interface NodeEditItemResult {
  nodeId: string;
  status: "updated" | "unchanged";
  updated: Array<"name" | "tags" | "checked" | "fields" | "position" | "data">;
  tags?: string[];
  parentId?: string;
  createdFields?: string[];
  unresolvedFields?: string[];
}
```

Result behavior:

- Reject a block that combines `merge_from` with outliner text. Merge changes structure
  and simultaneous text edits are confusing.
- `data` must be sanitized. Do not allow direct edits to `id`, `children`,
  `tags`, timestamps, or raw rich text internals through `data`.
- `parentId + afterId` moves the node. If `afterId` is provided and `parentId`
  is also provided, they must resolve to the same parent.
- `mergeFrom` redirects references from source to target, moves source children
  and fields where valid, merges tags, and trashes the source node.
- Multi-node edit returns one result item per target block, plus one operation entry for the
  whole transaction.
- If nothing changes, return `status: "unchanged"` with guidance to read the
  node and compare current state.

Single-node example result:

```json
{
  "ok": true,
  "tool": "node_edit",
  "version": 1,
  "status": "success",
  "data": {
    "status": "updated",
    "mode": "single",
    "updated": ["name", "tags", "fields", "checked"],
    "tags": ["task"],
    "createdFields": ["Status"]
  },
  "operation": {
    "operationId": "op_124",
    "undoGroupId": "undo_124",
    "origin": "agent",
    "action": "node_edit",
    "affectedNodeIds": ["node_1"],
    "summary": "Updated Publish release notes"
  }
}
```

Multi-node example call:

```json
{
  "changes": "@node_task_a\n- [X]\n\n@node_task_b\n- [ ]\n- Owner:: Alice\n\n@node_task_c\n> move parent=node_done after=node_task_b"
}
```

Multi-node example result:

```json
{
  "ok": true,
  "tool": "node_edit",
  "version": 1,
  "status": "success",
  "data": {
    "status": "updated",
    "mode": "multi",
    "items": [
      { "nodeId": "node_task_a", "status": "updated", "updated": ["checked"] },
      { "nodeId": "node_task_b", "status": "updated", "updated": ["checked", "fields"] },
      { "nodeId": "node_task_c", "status": "updated", "updated": ["position"], "parentId": "node_done" }
    ]
  },
  "operation": {
    "operationId": "op_125",
    "undoGroupId": "undo_125",
    "origin": "agent",
    "action": "node_edit",
    "affectedNodeIds": ["node_task_a", "node_task_b", "node_task_c"],
    "summary": "Updated 3 nodes"
  }
}
```

### `node_delete`

Move nodes to Trash, or restore them from Trash. Supports a single ID or an
array for batch operations. Works on any node: content, field values, and
references. Deleting a field value node clears that field. Deleting a reference
removes the link.

Parameters:

```ts
interface NodeDeleteParams {
  nodeId: string | string[];
  restore?: boolean; // true = restore from Trash; omit/false = move to Trash
}
```

Return data:

```ts
interface NodeDeleteData {
  action: "trashed" | "restored";
  count: number;
  name?: string; // single trash
  names?: string[]; // batch trash
  parentId?: string; // single restore
  items?: Array<{ id: string; parentId: string }>; // batch restore
}
```

Result behavior:

- Validate all node ids before mutating.
- Default is trash, not permanent delete.
- Agent v1 should not expose permanent delete through `node_delete`; hard delete
  can be a future, approval-heavy operation if needed.
- Batch delete is supported by passing an array. This is not a generic batch
  protocol; it is the natural shape of the delete operation.

### `operation_history`

Inspect, undo, or redo operations. Unlike nodex's AI-only `undo`, Lin should
support both user and agent operations because the agent may need to reason about
recent user edits or redo a user action on request.

Parameters:

```ts
interface OperationHistoryParams {
  action: "list" | "undo" | "redo";
  steps?: number; // default 1, max 20 for undo/redo
  scope?: "all" | "agent" | "user"; // default "all"
  limit?: number;  // for list, default 20, max 100
  offset?: number; // for list
}
```

Return data:

```ts
interface OperationHistoryData {
  action: "list" | "undo" | "redo";
  count: number;
  hasMore?: boolean;
  items?: OperationHistoryItem[];
  reverted?: OperationHistoryItem[];
  redone?: OperationHistoryItem[];
}

interface OperationHistoryItem {
  operationId: string;
  undoGroupId?: string;
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

- `list` is read-only and should not require approval.
- `undo` and `redo` mutate document state and usually require approval when they
  affect user operations.
- `scope: "agent"` should undo only agent-origin operations.
- `scope: "user"` should undo only user-origin operations.
- If history storage cannot list operations yet, implement `undo` and `redo`
  first but return a clear `boundary` for `list`.

## Local File Tools

File tools are for local workspace files. They must not mutate the outliner
document. The design mirrors cc-2.1's dedicated local tools:

- `file_read` maps to cc `Read`.
- `file_edit` maps to cc `Edit`.
- `file_write` maps to cc `Write`.
- `file_glob` maps to cc `Glob`.
- `file_grep` maps to cc `Grep`.

The model-facing descriptions, parameters, and `data` payloads should stay as
close to cc-2.1 as possible. Lin keeps lower snake case names and wraps the
payload in the common `ToolResult` envelope, but should not invent a second
filesystem protocol.

The important design rule is that `bash` is not the filesystem API. Agents
should use dedicated tools for reading, editing, writing, listing, and searching
files, and reserve `bash` for commands that actually need a shell.

Path rules:

- Concrete file tools use `file_path`.
- Search tools use `path` as an optional search root.
- Model-facing `file_path` values should be absolute paths. The adapter may
  resolve user-provided workspace-relative paths before the tool call, but Rust
  returns canonical absolute paths.
- Rust must enforce the active workspace boundary unless the user explicitly
  grants a broader root.

### `file_read`

Read a file with bounded output. This is the only tool that should inspect file
contents before an edit.

Parameters:

```ts
interface FileReadParams {
  file_path: string;
  offset?: number; // line offset, default 0
  limit?: number;  // max lines, default 2000
  pages?: string;  // PDF page selector, for example "1-3,7"
}
```

Return data:

```ts
type FileReadData =
  | FileReadTextData
  | FileReadImageData
  | FileReadPdfData
  | FileReadNotebookData
  | FileReadPartsData
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
    base64: string;
    type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    originalSize: number;
    dimensions?: {
      originalWidth?: number;
      originalHeight?: number;
      displayWidth?: number;
      displayHeight?: number;
    };
  };
}

interface FileReadPdfData {
  type: "pdf";
  file: {
    filePath: string;
    base64: string;
    originalSize: number;
  };
}

interface FileReadNotebookData {
  type: "notebook";
  file: {
    filePath: string;
    cells: unknown[];
  };
}

interface FileReadPartsData {
  type: "parts";
  file: {
    filePath: string;
    originalSize: number;
    count: number;
    outputDir: string;
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
  path?: string;   // optional absolute search root, default active workspace
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

- Results should be sorted by modified time, newest first, matching cc `Glob`.
- Rust should cap result count and set `truncated` when needed.
- Use `file_grep`, not `file_glob`, when the task is content search.

### `file_grep`

Search file contents. Use this instead of running `grep`, `rg`, or similar
commands through `bash`.

Parameters:

```ts
interface FileGrepParams {
  pattern: string; // regular expression
  path?: string;   // file or directory root, default active workspace
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
- `content` mode should include file paths and line numbers when useful.
- Multiline search should be explicit because it is more expensive.
- Rust must enforce hard output caps even when `head_limit` is `0`. If Lin needs
  to expose hard-cap truncation beyond cc's `appliedLimit`, put it in the common
  `ToolResult.metrics`, not inside `FileGrepData`.

### `file_edit`

Apply exact string replacements. This follows cc `Edit`: it is intentionally
not a mini patch language.

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
  gitDiff?: GitDiff;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface GitDiff {
  filename: string;
  status: "modified" | "added";
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  repository?: string | null;
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
- Include a file operation id in `operation.affectedPaths`.

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
  gitDiff?: GitDiff;
}
```

Result behavior:

- Creating a new file does not require a prior `file_read`.
- Updating an existing file requires a prior `file_read` freshness record.
- Overwriting a file should require approval.
- Do not use `file_write` to append small changes; use `file_edit`.

## Shell Tools

### `bash`

Run a local command. This follows cc `Bash`: it is for shell execution, not file
reading, file editing, or content search.

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
}
```

Result behavior:

- Commands run in the active workspace by default. Lin should not expose a
  model-facing `cwd` parameter initially; the agent can use shell syntax when a
  command truly needs another directory.
- Long-running commands should use `run_in_background: true` and return
  `backgroundTaskId`. The agent should not append `&`.
- Output must be bounded. Large output should be persisted and referenced by
  `persistedOutputPath`, which the agent can read with `file_read`.
- Risky commands require approval.
- Non-zero command exit is represented through `stdout`, `stderr`, and optional
  `returnCodeInterpretation`, not a separate model-facing `exitCode` field.
- Do not use `bash` to read, edit, write, glob, or grep files when the dedicated
  file tool fits the task.

### `task_stop`

Stop a background command created by `bash`. This follows cc `TaskStop`: it is
not a generic process manager and does not provide status/read/wait operations.

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
  user cookies and proxy settings work. A Rust HTTP client is acceptable for v1
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
  `nextStep` suggesting a broader query.
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

P1. Search and read previous Lin agent conversations.

Parameters:

```ts
interface PastChatsParams {
  query?: string;
  conversationId?: string;
  limit?: number;
}
```

Return data:

```ts
interface PastChatsData {
  total: number;
  items: Array<{
    conversationId: string;
    title: string;
    updatedAt: string;
    snippet: string;
  }>;
  conversation?: {
    conversationId: string;
    title: string;
    messages: Array<{
      role: "user" | "assistant" | "tool" | "system";
      text: string;
      createdAt: string;
    }>;
  };
}
```

## Mapping to Current Lin Commands

The public tools should compile down to Rust-backed commands. Current command
coverage maps as follows:

| Public tool | Current or needed backend capability |
|---|---|
| `node_search` | `search_nodes`, `backlinks`, future field/tag/date filters. |
| `node_read` | `get_projection`, `backlinks`, computed field and child summaries. |
| `node_create` | `create_node`, `create_nodes_from_tree`, `create_tag`, `create_field_def`, `add_reference`, `ensure_date_node`, future duplicate/search-node support. |
| `node_edit` | `update_node_text`, `toggle_done`, `apply_tag`, `remove_tag`, field value mutations, `move_node`, `merge_node_into_previous`, future semantic `mergeFrom`. |
| `node_delete` | `trash_node`, `batch_trash_nodes`, `restore_node`; hard delete is not exposed in the v1 agent tool. |
| `operation_history` | `undo`, `redo`, future operation log/list with origin metadata. |
| `file_read` | Needed Rust file read command with path normalization, pagination, and freshness tracking. |
| `file_glob` | Needed Rust glob command under allowed roots. |
| `file_grep` | Needed Rust grep/search command under allowed roots with output caps. |
| `file_edit` | Needed Rust exact-replacement command with read-before-edit freshness checks. |
| `file_write` | Needed Rust create/rewrite command with read-before-write freshness checks for existing files. |
| `bash` | Needed Rust command runner with timeout, approval, background task support, and output persistence. |
| `task_stop` | Needed Rust background task stop command scoped to Lin-created bash tasks. |
| `web_search` | Needed web search adapter: provider-backed search or embedded-browser SERP extraction, host permission scope, rate limiting, structured hints. |
| `web_fetch` | Needed URL fetch adapter: Rust HTTP and/or embedded browser session fetch, HTML-to-markdown extraction, pagination, find mode, structured hints. |

Lin should prefer adding semantic Rust core commands where the current command
set is too UI-shaped. For example, semantic `mergeFrom` is better for agents
than only `merge_node_into_previous`.

## Approval Policy

Read-only tools should run immediately when their permission scope is already
allowed:

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

Permanent delete, broad node edits, broad file edits, and risky shell commands
should require approval even in permissive modes.

## Implementation Notes

- Tool schemas live in the TypeScript pi-mono adapter, but validation and
  mutation semantics should be enforced again in Rust.
- The TypeScript adapter should remain thin: normalize parameters, invoke Tauri,
  and convert Rust responses into `ToolResult`.
- Rust should own outliner parsing, tag resolution, field resolution, operation
  grouping, permissions, and persistence.
- All document mutations should create an operation history entry with origin,
  summary, affected nodes, and undo group id.
- Active UI context is injected every user turn and should not be fetched with a
  tool.
- Large tool outputs must be paginated or truncated with `metrics.truncated`.
- Tool results should be stable enough to persist in conversation history.
