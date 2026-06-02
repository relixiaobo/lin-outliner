export const DATE_FIELD_VALUE_GUIDANCE =
  'Date field values use YYYY-MM-DD, YYYY-MM-DDTHH:mm, or start/end with "/" such as 2026-05-20/2026-05-24. Do not use ".." for date ranges.';

export const NODE_REFERENCE_GUIDANCE =
  'Node references use [[node:Display^...]] markers, or [[node:^...]] when only the id is known. Exact node ids are also accepted in tool parameters.';

export const FINAL_ANSWER_NODE_REFERENCE_GUIDANCE =
  'For final answers, never show %%node:id%% edit handles. Mention concrete nodes with [[node:Display^...]], or [[node:^...]] when only the id is known.';

export const LIN_OUTLINE_CREATE_GUIDANCE = [
  'Outline format uses "- Title" lines with exactly 2 spaces per child level.',
  'It supports "Title - description", #tags, #[[multi word tags]], Field:: value, references, nested children, search nodes, and [ ]/[x] checkbox state.',
  DATE_FIELD_VALUE_GUIDANCE,
  'Do not include %%node:id%% markers when creating new nodes; those markers belong to node_read/node_edit protocol.',
].join(' ');

export const ANNOTATED_OUTLINE_EDIT_GUIDANCE = [
  'Annotated outlines come from node_read and include %%node:id%% markers for exact follow-up edits.',
  'Keep markers for existing nodes that should be updated or moved. Lines without markers create new nodes under the edited outline.',
  'Treat %%node:id%% as protocol metadata, not user-visible node text.',
  FINAL_ANSWER_NODE_REFERENCE_GUIDANCE,
].join(' ');

export const SEARCH_QUERY_SHAPE_GUIDANCE = [
  'Search outlines start with one root line like "- %%search%% Title" and exactly one query root child.',
  'AND, OR, and NOT are group nodes and may be nested.',
  'Rule nodes are operator names. Put operands under rules as field::, tag::, target::, value::, or operand:: lines.',
  'field::, tag::, and target:: must be node references or exact node ids. Plain field names, tag names, and target titles are not enough.',
  NODE_REFERENCE_GUIDANCE,
  DATE_FIELD_VALUE_GUIDANCE,
].join(' ');

export const SEARCH_OPERATOR_REFERENCE = [
  'Operator guide:',
  '- Text: STRING_MATCH value:: text; REGEXP_MATCH value:: regex.',
  '- Tags: HAS_TAG tag:: [[node:#tag^...]].',
  '- Checkbox/completion state: TODO, DONE, NOT_DONE, DONE_LAST_DAYS value:: 7. Do not express done state as FIELD_IS field:: done value:: true.',
  '- Timestamps: CREATED_LAST_DAYS value:: 7, EDITED_LAST_DAYS value:: 7, DONE_LAST_DAYS value:: 7.',
  '- User fields: FIELD_IS, FIELD_IS_NOT, FIELD_CONTAINS, LT, GT, IS_EMPTY, IS_NOT_EMPTY, HAS_FIELD, FIELD_IS_SET, FIELD_IS_NOT_SET, FIELD_IS_DEFINED, FIELD_IS_NOT_DEFINED. These use field:: [[node:Field^...]] except HAS_FIELD may omit field:: to match any field.',
  '- Date fields: DATE_OVERLAPS uses field:: [[node:Date field^...]] plus value:: YYYY-MM-DD or start/end. OVERDUE checks unfinished nodes with overdue date field values and may include field:: to limit which date field.',
  '- Date/calendar nodes: FOR_DATE and FOR_RELATIVE_DATE use value:: date to match date-related nodes; ON_DAY_NODE matches nodes under day nodes.',
  '- Links and structure: LINKS_TO, CHILD_OF, DESCENDANT_OF, DESCENDANT_OF_WITH_REFS, and OWNED_BY use target:: [[node:Node^...]]. PARENTS_DESCENDANTS, GRANDPARENTS_DESCENDANTS, PARENTS_DESCENDANTS_WITH_REFS, and GRANDPARENTS_DESCENDANTS_WITH_REFS are scoped to the saved search node position. SIBLING_NAMED uses value:: sibling title. IN_LIBRARY needs no operand.',
  '- Type/media: IS_TYPE value:: node|tag|field|search|day|week|year|image|embed|code; HAS_MEDIA, HAS_AUDIO, HAS_VIDEO, and HAS_IMAGE need no operand.',
  '- EDITED_BY exists in the data model but is not executable yet. Do not use it.',
].join('\n');

export const SEARCH_QUERY_EXAMPLES = [
  'Examples:',
  '- Completed recently: "- %%search%% Recently completed\\n  - DONE_LAST_DAYS\\n    - value:: 7"',
  '- Due in a date range: "- %%search%% Due soon\\n  - DATE_OVERLAPS\\n    - field:: [[node:Due^...]]\\n    - value:: 2026-05-20/2026-05-24"',
  '- Open tagged work: "- %%search%% Open tasks\\n  - AND\\n    - HAS_TAG\\n      - tag:: [[node:#task^...]]\\n    - FIELD_IS\\n      - field:: [[node:Status^...]]\\n      - value:: Open"',
].join('\n');

export const NODE_SEARCH_DESCRIPTION = [
  'Searches outliner nodes by executing a temporary search outline or an existing saved search node.',
  '',
  'Usage:',
  '- Use outline for one-off searches; use search_node_id only when executing an existing saved search node.',
  `- ${SEARCH_QUERY_SHAPE_GUIDANCE}`,
  '- Match system checkbox/completion state with TODO, DONE, NOT_DONE, or DONE_LAST_DAYS. These are not field queries.',
  '- Use DATE_OVERLAPS only for values stored in a date field; field:: must reference the date field definition node.',
  '- Use FIELD_IS and related field operators only for user fields; find the field definition id with node_read/node_search when needed.',
  '- Returned outlines include %%node:id%% markers so you can call node_read or node_edit on exact matches.',
  '',
  SEARCH_OPERATOR_REFERENCE,
  '',
  SEARCH_QUERY_EXAMPLES,
].join('\n');

export const NODE_SEARCH_OUTLINE_PARAMETER_DESCRIPTION = [
  'Temporary search outline. This does not create a saved search node.',
  SEARCH_QUERY_SHAPE_GUIDANCE,
  SEARCH_OPERATOR_REFERENCE,
  SEARCH_QUERY_EXAMPLES,
].join('\n');

export const NODE_CREATE_DESCRIPTION = [
  'Creates outliner content under a parent. Omit parent_id to create under today, not the current UI selection.',
  '',
  'Usage:',
  `- Use outline for normal nodes, fields, tags, references, saved search nodes, and nested children. ${LIN_OUTLINE_CREATE_GUIDANCE}`,
  '- Use target_id only to create one reference node at the insertion point.',
  '- Use duplicate_id only to duplicate an existing subtree with new ids.',
  '- Insertion: after_id omitted appends, after_id null inserts first, after_id string inserts after that sibling.',
  '- Use preview_only to parse and validate before mutating the document.',
].join('\n');

export const NODE_CREATE_OUTLINE_PARAMETER_DESCRIPTION = [
  'Outline format to create.',
  LIN_OUTLINE_CREATE_GUIDANCE,
  `Saved search nodes use the same search query outline syntax as node_search. ${SEARCH_QUERY_SHAPE_GUIDANCE}`,
].join(' ');

export const NODE_EDIT_DESCRIPTION = [
  'Edits existing outliner content.',
  '',
  'Usage:',
  '- For text and child-structure edits, use node_read first, then pass exact old_string/new_string against the annotated outline.',
  '- old_string "*" replaces the whole annotated outline for node_id.',
  `- ${ANNOTATED_OUTLINE_EDIT_GUIDANCE}`,
  `- ${DATE_FIELD_VALUE_GUIDANCE}`,
  '- Also supports user-like move operations, merging source nodes into one surviving target, and replacing a node with a reference.',
  '- Use preview_only when the edit is large or ambiguous and you want validation before mutating the document.',
].join('\n');

export const NODE_EDIT_NEW_STRING_PARAMETER_DESCRIPTION = [
  'Replacement fragment. The full outline after replacement must parse as outline format and may keep %%node:id%% markers for existing nodes.',
  ANNOTATED_OUTLINE_EDIT_GUIDANCE,
  DATE_FIELD_VALUE_GUIDANCE,
].join(' ');

export const NODE_READ_DESCRIPTION = [
  'Reads outliner nodes as annotated outline text with %%node:id%% markers for exact follow-up edits.',
  '',
  'Usage:',
  '- Omit node_id and node_ids to read today.',
  '- Use node_ids for independent nodes. Use depth, child_offset, and child_limit to bound children.',
  '- Use node_read before node_edit whenever you need exact node ids, revisions, or outline fragments.',
  `- ${ANNOTATED_OUTLINE_EDIT_GUIDANCE}`,
].join('\n');

export const NODE_DELETE_DESCRIPTION = [
  'Moves one or more outliner nodes to Trash, or restores nodes from Trash with restore true. This is not a permanent delete.',
  '',
  'Usage:',
  '- Use node_id for one node, or node_ids for a batch that matches a user multi-selection.',
  '- Children and fields move with their parent. If both a parent and its descendant are provided, the descendant is skipped because the parent covers it.',
  '- Use preview_only to inspect affected nodes before mutating the document.',
].join('\n');

export const OPERATION_HISTORY_DESCRIPTION = [
  'Inspect, undo, or redo outliner operations.',
  '',
  'Usage:',
  '- Use action "list" first when you need to see recent user and agent operations before deciding what to undo or redo.',
  '- Undo/redo uses the Loro-backed operation stack. Agent calls default to the agent-origin stack so agent undo does not unexpectedly undo user work.',
  '- Use operation_id as a guard when undoing or redoing a specific visible operation.',
].join('\n');
