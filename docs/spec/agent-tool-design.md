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
| `node_search` | outliner | No | No | Execute a temporary or saved search node outline. |
| `node_read` | outliner | No | No | Read node raw type/data, fields, and bounded children. |
| `node_create` | outliner | Yes | Usually yes | Create outline trees, references, search/view nodes, schema nodes, or duplicates. |
| `node_edit` | outliner | Yes | Usually yes | Edit the canonical outline for a known node using exact string replacement, or perform explicit structure operations such as move and merge. |
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
  preview?: ToolPreview;
  validation?: ValidationReport;
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

Guidance fields are first-class:

- `boundary`: what the tool intentionally did not do.
- `nextStep`: the recommended next tool call or action.
- `fallback`: an alternative if the recommended path fails.
- `hint`: short agent-facing correction.

Use guidance fields for unknown tags, unresolved fields, permission denials,
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
  "nextStep": "Use node_search or node_read on the parent context to find the correct node id.",
  "hint": "The node id may be stale after a delete, restore, or undo."
}
```

## Node Tool Contract

Node tools use the compact nodex-style surface, but Lin does not expose nodex's
incremental `text` edit contract. Lin uses one canonical outline format for
creation, reading, and text replacement edits:

- `node_create.outline` inserts new structure.
- `node_read(..., format: "outline" | "both")` serializes existing structure.
- `node_edit.oldString/newString` edits that serialized outline by exact string
  replacement, then TypeScript parses and applies the result.

The agent-facing outline must stay clean. Do not embed node ids, internal CRDT
metadata, timestamps, or implementation markers in outline text. Identity comes
from explicit tool parameters (`nodeId`, `parentId`, `afterId`) and from the
structured `node_read` payload. TypeScript may keep an internal span map from
serialized text ranges to node ids, but that map is not model-visible.

`operation_history` is a Lin extension over nodex's AI-only `undo` tool. Keep it
separate from the `node_*` tools.

Read/create/edit symmetry:

- `node_read` returns structured ids plus optional `outline` text for the same
  node subtree.
- `node_create` accepts the same outline format without embedded ids. The
  insertion point is controlled by `parentId` and `afterId`; omitted `parentId`
  means today's journal node, not the currently focused UI node.
- `node_edit` targets one existing root by `nodeId`, applies exact
  `oldString/newString` replacement to the outline returned by `node_read`, and
  then lets TypeScript parse the full resulting outline.
- Precise child edits should target that child's `nodeId` directly. Parent
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
  - Owner:: [[Alice^node_alice]]
  - [ ] Follow up
  - Notes
    - Prepare agenda
  - %%search%% Open tasks %%view:table%%
    - [[#task]]
    - Status:: Open
```

Rules:

- Every non-empty line starts with `- ` after indentation.
- Indentation is exactly 2 spaces per level. Tabs and uneven indentation are an
  error in model-facing output.
- `- title` creates or serializes a node title.
- `- title - description` sets a node description. The first ` - ` separates
  title from description; later ` - ` text stays in the description.
- `#tag` and `#[[multi word tag]]` apply tags.
- `[ ]`, `[x]`, and `[X]` at the start of a node set checkbox state.
- `Field:: value` sets a single field value.
- `Field::` followed by indented value lines sets a multi-value field.
- `Field::` without values clears that field in edit results.
- Whole-line `[[Display^nodeId]]` creates a reference node or reference field
  value.
- Inline `[[Display^nodeId]]` creates an inline reference inside node text or a
  field value.
- `[[date:YYYY-MM-DD]]` creates or resolves a date reference.
- `%%search%%` turns the node into a search node. In `node_create` this creates a
  saved search node; in `node_search` it is a temporary search node that is only
  executed and rendered.
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

interface InlineRef {
  display: string;
  targetId: string;
  offset?: number;
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
  | "password"
  | "formula"
  | "url"
  | "email"
  | "checkbox"
  | "boolean"
  | "color";
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

- `[[Display^nodeId]]` requires `nodeId` to exist unless the reference is a date
  directive.
- Date references create or reuse date nodes.
- Tag references such as `[[#task]]` resolve to tag definition nodes.

## Outliner Tools

### `node_search`

Execute a temporary or saved search node. Use this to locate nodes before
editing and to render temporary search results without creating a real node.
`node_search.outline` uses the same search-node outline shape that
`node_create.outline` would use to create a saved search node.

Parameters:

```ts
interface NodeSearchParams {
  outline?: string;
  searchNodeId?: string;
  limit?: number; // default 20, max 50
  offset?: number;
  count?: boolean;
}
```

Exactly one of `outline` and `searchNodeId` is required.

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
  unresolvedTags?: string[];
  unresolvedFields?: string[];
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
- The outline must parse as one search node root. If `%%search%%` is omitted,
  the runtime may still treat the root as a temporary search node, but tool
  descriptions should teach agents to include `%%search%%`.
- The root title is returned as `title` and may be used for temporary UI display.
- `%%view:table%%`, `%%view:list%%`, `%%view:cards%%`, and similar directives are
  returned as `view` and drive temporary result presentation.
- Child lines are search conditions using the same parser as saved search nodes:
  plain text is full-text search, tag references filter by tag, field lines
  filter by field value, and node/date references filter by relationship or date.
- `searchNodeId` executes an existing saved search node.
- Subtree restriction, parent restriction, backlink search, and relationship
  filters should be represented as search conditions in the outline, not as
  separate tool parameters.
- `count: true` returns total and guidance without item payloads.

Examples:

```json
{
  "outline": "- %%search%% 成都天气 %%view:list%%\n  - 成都天气"
}
```

```json
{
  "outline": "- %%search%% 今日开放任务 %%view:table%%\n  - [[#task]]\n  - Status:: Open\n  - Due:: [[date:2026-05-13]]",
  "limit": 20
}
```

```json
{
  "searchNodeId": "node_saved_search"
}
```

### `node_read`

Read nodes as structured data and, when requested, as canonical Lin Outline
Format. The structured payload carries ids. The outline is clean model-facing
text and does not contain ids.

Parameters:

```ts
interface NodeReadParams {
  nodeId?: string; // default: today's journal node
  nodeIds?: string[];
  depth?: number; // 0 = node only, default 1, max 3
  childOffset?: number;
  childLimit?: number; // default 20, max 50
  format?: "structured" | "outline" | "both"; // default "both"
  includeDeleted?: boolean;
  includeBacklinks?: boolean;
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

- Omitted `nodeId` reads today's journal node.
- Use either `nodeId` or `nodeIds`, not both. If both are omitted, read today's
  journal node.
- `nodeIds` returns multiple independent `items`.
- `outline` serializes the requested node and bounded descendants using the same
  canonical format accepted by `node_create` and `node_edit`.
- If children are truncated, return pagination and do not serialize hidden
  children into `outline`.
- To edit a child precisely, use the child `nodeId` from `children.items` and
  call `node_edit` on that child directly.

### `node_create`

Create new outliner content under a parent. The normal path is `outline`, which
may create one node, many sibling nodes, or a full subtree. Reference creation
and subtree duplication are explicit shortcuts because they depend on exact ids.

Parameters:

```ts
interface NodeCreateParams {
  parentId?: string; // default: today's journal node
  afterId?: string | null; // null = first child; omitted = last child
  outline?: string;
  targetId?: string; // create one reference node to this target
  duplicateId?: string; // deep-copy this subtree
  previewOnly?: boolean;
}
```

Exactly one of `outline`, `targetId`, and `duplicateId` is required.

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
  revisions?: Record<string, string>;
  unresolvedTags?: string[];
  unresolvedFields?: string[];
}
```

Result behavior:

- If `afterId` is provided without `parentId`, the parent is `afterId`'s parent.
- If both are provided, `afterId` must be a child of `parentId`.
- If `outline` has multiple root lines, the first root is inserted at the
  requested position and following roots are inserted after the previous root.
- `targetId` creates one reference node at the requested position.
- `duplicateId` deep-copies the source subtree at the requested position.
- Missing tags and fields may be auto-created only when policy allows it.
- Search/view directives, schema-like tag/field structures, dates, references,
  descriptions, checkboxes, and fields all come through `outline`.
- `previewOnly: true` returns preview and validation without applying.

Example:

```json
{
  "outline": "- Project Alpha - Q2 rollout #project\n  - Status:: Active\n  - [ ] Draft plan"
}
```

### `node_edit`

Edit existing outliner content. The content edit path mirrors cc-style exact
replacement: read the node, copy an exact fragment from the returned canonical
outline, and replace it with a new canonical fragment.

Parameters:

```ts
type NodeEditParams =
  | NodeOutlineEditParams
  | NodeMoveParams
  | NodeMergeParams
  | NodeReferenceReplaceParams;

interface NodeOutlineEditParams {
  nodeId: string;
  oldString: string; // exact fragment from node_read.outline, or "*" for full outline
  newString: string;
  expectedRevision?: string;
  previewOnly?: boolean;
}

interface NodeMoveParams {
  nodeId?: string;
  nodeIds?: string[];
  move: {
    parentId?: string;
    afterId?: string | null;
    structuralAction?: "indent" | "outdent" | "move_up" | "move_down";
  };
  previewOnly?: boolean;
}

interface NodeMergeParams {
  nodeId: string; // target node
  mergeFromNodeIds: string[]; // source nodes
  previewOnly?: boolean;
}

interface NodeReferenceReplaceParams {
  nodeId: string;
  replaceWithReferenceTo: string;
  previewOnly?: boolean;
}
```

Outline edit semantics:

- `oldString !== "*"` must match exactly once in the current canonical outline
  for `nodeId`.
- `oldString === "*"` is a sentinel that replaces the whole canonical outline for
  `nodeId`. It is not a wildcard or regular expression; `*` has special meaning
  only when it is the entire value.
- `newString` is not parsed in isolation. The full outline after replacement must
  be valid Lin Outline Format.
- Whole-line or whole-subtree replacements are preferred. Smaller string
  fragments are allowed when the resulting outline is still valid and the match
  is exact.
- For `oldString: "*"`, `newString` must contain exactly one root line because
  that root maps to `nodeId`.
- TypeScript replaces the matched fragment, parses the resulting whole outline, builds
  a mutation plan, validates it, renders a preview, and then applies it after
  approval when needed.
- The root of a full-outline replacement maps to `nodeId`. If the replacement
  would make the root ambiguous, return an error.
- For precise child edits, prefer `node_read` to obtain the child `nodeId`, then
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

- `parentId + afterId` is an absolute move.
- `structuralAction` mirrors user operations: indent, outdent, move up, move
  down.
- `nodeIds` is allowed only for homogeneous move operations.
- Moving a node under itself or under one of its descendants is invalid.

Merge semantics:

- `nodeId` is the target that survives.
- `mergeFromNodeIds` are sources whose children, fields, tags, and references
  are merged into the target.
- Sources are moved to Trash after merge.
- Source order determines child append order.
- Target title and position are preserved.
- References to sources are redirected to the target.
- Merge cannot be combined with outline edit or move in the same call.

Reference replacement semantics:

- `replaceWithReferenceTo` replaces the node at `nodeId` with a reference node to
  the target at the same parent and position.
- The original node is moved to Trash after the replacement, preserving undo.
- If `nodeId` is already a reference, only its target is changed.

Return data:

```ts
interface NodeEditData {
  action: "outline_edit" | "move" | "merge" | "replace_with_reference";
  status: "updated" | "unchanged";
  affectedNodeIds: string[];
  createdNodeIds?: string[];
  trashedNodeIds?: string[];
  movedNodeIds?: string[];
  updatedFields?: string[];
  updatedTags?: string[];
  unresolvedTags?: string[];
  unresolvedFields?: string[];
  beforeOutline?: string;
  afterOutline?: string;
  revisions?: Record<string, string>;
  merge?: {
    targetNodeId: string;
    sourceNodeIds: string[];
    movedChildren: number;
    redirectedReferences: number;
    mergedFields: Array<{ name: string; addedValues: number }>;
  };
}
```

Examples:

```json
{
  "nodeId": "node_task",
  "oldString": "*",
  "newString": "- [x] Check Chengdu weather #weather"
}
```

```json
{
  "nodeId": "node_project",
  "oldString": "  - Task B\n  - Task C",
  "newString": "  - Task B\n  - [ ] Task D\n  - Task C"
}
```

```json
{
  "nodeIds": ["node_task_a", "node_task_b"],
  "move": { "parentId": "node_done" }
}
```

```json
{
  "nodeId": "node_canonical",
  "mergeFromNodeIds": ["node_duplicate_1", "node_duplicate_2"]
}
```

```json
{
  "nodeId": "node_old",
  "replaceWithReferenceTo": "node_canonical"
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
  nodeId?: string;
  nodeIds?: string[];
  restore?: boolean; // true = restore from Trash; omit/false = move to Trash
  previewOnly?: boolean;
}
```

Return data:

```ts
interface NodeDeleteData {
  action: "trashed" | "restored";
  count: number;
  nodeIds: string[];
  items?: Array<{ nodeId: string; parentId?: string; title?: string }>;
  revisions?: Record<string, string>;
}
```

Result behavior:

- Use either `nodeId` or `nodeIds`, not both.
- Validate all node ids before mutating.
- Delete means move to Trash. Agent v1 does not expose permanent delete.
- Restore uses the node's recorded original parent/position when available. If
  the original location is no longer valid, return an error with guidance instead
  of guessing a new parent.
- Batch delete is supported by `nodeIds`. This is not a generic batch protocol;
  it is the natural shape of the delete operation.

### `operation_history`

Inspect, undo, or redo operations. Unlike nodex's AI-only `undo`, Lin should
support both user and agent operations because the agent may need to reason about
recent user edits or redo a user action on request.

Parameters:

```ts
interface OperationHistoryParams {
  action: "list" | "undo" | "redo";
  steps?: number; // default 1, max 10 for undo/redo
  operationId?: string; // stack-top guard, not arbitrary history jumping
  origin?: "all" | "agent" | "user"; // default "all"
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
  undone?: OperationHistoryItem[];
  redone?: OperationHistoryItem[];
  canUndo: boolean;
  canRedo: boolean;
  cursor?: {
    undoDepth: number;
    redoDepth: number;
  };
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
- `undo` and `redo` are stack operations. Agent v1 does not support arbitrary
  history jumping.
- `steps` defaults to 1 and should stay small. Initial maximum: 10.
- `origin: "agent"` means undo/redo the nearest stack operation whose origin is
  agent, stopping at unsafe dependencies.
- `origin: "user"` means undo/redo the nearest user-origin stack operation and
  usually requires approval.
- `operationId` is only a guard for the current stack target or a continuous
  stack range. If it would require skipping unrelated later operations, return
  `boundary` and do nothing.
- Undoing user-origin operations requires approval by default.
- Redo follows the redo stack and must fail if a new document mutation has
  invalidated the redo stack.
- If history storage cannot list operations yet, implement `undo` and `redo`
  first but return a clear `boundary` for `list`.

## TypeScript Parser, Preview, and Validation

TypeScript owns the complete outliner mutation pipeline. The TypeScript adapter should
only normalize arguments, invoke Electron IPC commands, and wrap TypeScript responses in
`ToolResult`.

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

`SerializedOutline` contains the model-facing text plus an internal span map:

```ts
interface SerializedOutline {
  text: string;
  revision: string;
  spanMap: OutlineSpan[];
}

interface OutlineSpan {
  start: number;
  end: number;
  nodeId: NodeId;
  fieldEntryId?: NodeId;
  valueNodeId?: NodeId;
}
```

The span map is not returned to the model. It lets TypeScript understand which current
nodes were touched by `oldString/newString` without polluting the outline with id
markers.

### `node_edit` flow

Content edits use this sequence:

```txt
load current node state
  -> serialize current canonical outline and internal span map
  -> check expectedRevision when provided
  -> replace oldString with newString
  -> parse the whole replacement result
  -> resolve tags, fields, refs, dates, search/view directives
  -> build MutationPlan using the old span map as identity context
  -> validate MutationPlan
  -> render preview
  -> wait for approval when required
  -> apply MutationPlan as one transaction and one undo group
```

`oldString` matching rules:

- `oldString === "*"` replaces the whole serialized outline for `nodeId`.
- Otherwise, `oldString` must match exactly once.
- Zero matches means the agent is using stale context and should call
  `node_read` again.
- Multiple matches means the agent should include more surrounding context or
  edit the child directly by `nodeId`.
- Matching is byte-exact against the canonical outline string returned by
  `node_read`, after normalizing line endings to `\n`.

Identity rules:

- The root of a full-outline replacement maps to the `nodeId` argument.
- Unchanged text outside the replacement keeps identity through the span map.
- Inside the replacement range, TypeScript may preserve identity only when the old and
  new fragment shape makes the mapping unambiguous.
- If a changed fragment contains repeated sibling titles or nodes with fields,
  children, references, or history and identity cannot be proven, validation must
  reject the edit and tell the agent to target the relevant child `nodeId`
  directly.

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
- `parentId`, `afterId`, `nodeId`, `nodeIds`, `targetId`, and
  `mergeFromNodeIds` exist and are editable.
- `afterId` is a child of `parentId` when both are provided.
- Moves cannot create cycles and cannot move locked/system nodes.
- Batch move operations are homogeneous and preserve selected-root semantics.
- Merge target and sources are distinct and have no unsafe ancestor/descendant
  relationship.
- Field values match field type constraints.
- Tag and field auto-creation follows the active policy.
- Search/view directives compile to valid internal configs.
- `expectedRevision` matches when provided.
- Parser compatibility normalization does not silently change meaning.

Validation should produce structured guidance:

```ts
interface ValidationReport {
  ok: boolean;
  errors: Array<{ code: string; message: string; span?: SourceSpan }>;
  warnings: Array<{ code: string; message: string; span?: SourceSpan }>;
  unresolvedTags?: string[];
  unresolvedFields?: string[];
  nextStep?: string;
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
  resolve user-provided workspace-relative paths before the tool call, but TypeScript
  returns canonical absolute paths.
- TypeScript must enforce the active workspace boundary unless the user explicitly
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
- TypeScript should cap result count and set `truncated` when needed.
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
- TypeScript must enforce hard output caps even when `head_limit` is `0`. If Lin needs
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

The public tools should compile down to TypeScript-backed commands. Current command
coverage maps as follows:

| Public tool | Current or needed backend capability |
|---|---|
| `node_search` | Temporary/saved search node parser compiled to `search_nodes`, backlinks, tag/field/date filters, relationship filters, and view metadata. |
| `node_read` | `get_projection`, `backlinks`, canonical outline serialization, computed field and child summaries. |
| `node_create` | `create_node`, `create_nodes_from_tree`, `create_tag`, `create_field_def`, `add_reference`, `ensure_date_node`, duplicate/search-node support. |
| `node_edit` | Canonical outline exact replacement compiled to `update_node_text`, `toggle_done`, tag/field mutations, `move_node`, `merge_node_into`, reference replacement, and search/view updates. |
| `node_delete` | `trash_node`, `batch_trash_nodes`, `restore_node`; permanent delete is not exposed to agent v1. |
| `operation_history` | `undo`, `redo`, future operation log/list with origin metadata. |
| `file_read` | Needed TypeScript file read command with path normalization, pagination, and freshness tracking. |
| `file_glob` | Needed TypeScript glob command under allowed roots. |
| `file_grep` | Needed TypeScript grep/search command under allowed roots with output caps. |
| `file_edit` | Needed TypeScript exact-replacement command with read-before-edit freshness checks. |
| `file_write` | Needed TypeScript create/rewrite command with read-before-write freshness checks for existing files. |
| `bash` | Needed Electron IPC command runner with timeout, approval, background task support, and output persistence. |
| `task_stop` | Needed TypeScript background task stop command scoped to Lin-created bash tasks. |
| `web_search` | Needed web search adapter: provider-backed search or embedded-browser SERP extraction, host permission scope, rate limiting, structured hints. |
| `web_fetch` | Needed URL fetch adapter: TypeScript HTTP and/or embedded browser session fetch, HTML-to-markdown extraction, pagination, find mode, structured hints. |

Lin should prefer adding semantic TypeScript core commands where the current command
set is too UI-shaped. For example, semantic target/source merge is better for
agents than only `merge_node_into_previous`.

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

Broad node edits, broad file edits, user-origin undo/redo, and risky shell
commands should require approval even in permissive modes.

## Implementation Notes

- Tool schemas live in the TypeScript pi-mono adapter, but validation and
  mutation semantics should be enforced again in TypeScript.
- The TypeScript adapter should remain thin: normalize parameters, invoke Electron,
  and convert TypeScript responses into `ToolResult`.
- TypeScript should own outliner parsing, tag resolution, field resolution, operation
  grouping, permissions, and persistence.
- All document mutations should create an operation history entry with origin,
  summary, affected nodes, and undo group id.
- Active UI context is injected every user turn and should not be fetched with a
  tool.
- Large tool outputs must be paginated or truncated with `metrics.truncated`.
- Tool results should be stable enough to persist in conversation history.
