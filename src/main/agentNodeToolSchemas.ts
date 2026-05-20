import {
  NODE_CREATE_OUTLINE_PARAMETER_DESCRIPTION,
  NODE_EDIT_NEW_STRING_PARAMETER_DESCRIPTION,
  NODE_SEARCH_OUTLINE_PARAMETER_DESCRIPTION,
} from './agentNodeToolGuidance';

export const NODE_READ_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    node_id: {
      type: 'string',
      minLength: 1,
      description: "The node id to read. Omit node_id and node_ids to read today's journal node.",
    },
    node_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string', minLength: 1 },
      description: 'Node ids to read in one call. Use this for independent nodes; do not combine with node_id.',
    },
    depth: {
      type: 'integer',
      minimum: 0,
      maximum: 3,
      description: 'Descendant depth to include. 0 reads only the requested node, 1 includes direct children. Default 1, max 3.',
    },
    child_offset: {
      type: 'integer',
      minimum: 0,
      description: 'Skip the first N root children before applying child_limit. Default 0.',
    },
    child_limit: {
      type: 'integer',
      minimum: 0,
      maximum: 50,
      description: 'Maximum root children to return in this page. Default 20, max 50.',
    },
    include_deleted: {
      type: 'boolean',
      description: 'Set true only when you intentionally need to read nodes in Trash. Default false.',
    },
    include_backlinks: {
      type: 'boolean',
      description: 'Include tree, inline, and field backlinks to the requested nodes. Default false.',
    },
  },
};

export const NODE_SEARCH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  oneOf: [
    { required: ['outline'] },
    { required: ['search_node_id'] },
  ],
  properties: {
    outline: {
      type: 'string',
      minLength: 1,
      maxLength: 12000,
      description: NODE_SEARCH_OUTLINE_PARAMETER_DESCRIPTION,
    },
    search_node_id: {
      type: 'string',
      minLength: 1,
      description: 'Existing saved search node id to execute. Use outline instead for a one-off search.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Maximum matching nodes to return. Default 20, max 50.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'Skip the first N matching nodes before returning results. Default 0.',
    },
    count: {
      type: 'boolean',
      description: 'When true, return only the total count without result items.',
    },
  },
};

export const NODE_CREATE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  oneOf: [
    { required: ['outline'] },
    { required: ['target_id'] },
    { required: ['duplicate_id'] },
  ],
  properties: {
    parent_id: {
      type: 'string',
      minLength: 1,
      description: "Parent node id. Omit to create under today's journal node, not the current UI selection.",
    },
    after_id: {
      anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
      description: 'Sibling insertion point under parent_id. Omit to append, pass null to insert as first child, or pass a sibling id to insert after that sibling.',
    },
    outline: {
      type: 'string',
      minLength: 1,
      maxLength: 60000,
      description: NODE_CREATE_OUTLINE_PARAMETER_DESCRIPTION,
    },
    target_id: {
      type: 'string',
      minLength: 1,
      description: 'Create one reference node to this target node id at the insertion point. Use outline for normal nodes.',
    },
    duplicate_id: {
      type: 'string',
      minLength: 1,
      description: 'Duplicate an existing subtree by serializing and recreating its outline with new node ids.',
    },
    preview_only: {
      type: 'boolean',
      description: 'Parse and validate only; do not mutate the document.',
    },
  },
};

export const NODE_DELETE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  oneOf: [
    { required: ['node_id'] },
    { required: ['node_ids'] },
  ],
  properties: {
    node_id: {
      type: 'string',
      minLength: 1,
      description: 'Single node id to move to Trash. This is not a permanent delete.',
    },
    node_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: { type: 'string', minLength: 1 },
      description: 'Multiple node ids to move to Trash as one operation. Use this for selected-row style batch deletes; do not combine with node_id.',
    },
    restore: {
      type: 'boolean',
      description: 'Restore nodes from Trash instead of moving them to Trash.',
    },
    preview_only: {
      type: 'boolean',
      description: 'Validate and describe affected nodes only; do not mutate the document.',
    },
  },
};

export const NODE_EDIT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  oneOf: [
    { required: ['node_id', 'old_string', 'new_string'] },
    {
      required: ['move'],
      anyOf: [{ required: ['node_id'] }, { required: ['node_ids'] }],
    },
    { required: ['node_id', 'merge_from_node_ids'] },
    { required: ['node_id', 'replace_with_reference_to'] },
  ],
  properties: {
    node_id: {
      type: 'string',
      minLength: 1,
      description: 'Target node id. Required for outline edits, single-node moves, merge target, and reference replacement. Use node_read first when you need the current id or revision.',
    },
    node_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: { type: 'string', minLength: 1 },
      description: 'Target node ids for one homogeneous move operation, matching a user multi-selection. Do not combine with node_id except where the action explicitly allows it.',
    },
    old_string: {
      type: 'string',
      minLength: 1,
      description: 'Exact fragment from node_read annotated outline, or "*" to replace the whole annotated outline for node_id. Include enough surrounding lines to make the fragment unique.',
    },
    new_string: {
      type: 'string',
      description: NODE_EDIT_NEW_STRING_PARAMETER_DESCRIPTION,
    },
    expected_revision: {
      type: 'string',
      minLength: 1,
      description: 'Optional revision from node_read. The edit fails if the node changed since that read.',
    },
    move: {
      type: 'object',
      additionalProperties: false,
      properties: {
        parent_id: {
          type: 'string',
          minLength: 1,
          description: 'Destination parent node id for an absolute move. Use with after_id; do not combine with structural_action.',
        },
        after_id: {
          anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          description: 'Destination sibling under parent_id. Omit to append, pass null to insert as first child, or pass a sibling id to insert after that sibling.',
        },
        structural_action: {
          type: 'string',
          enum: ['indent', 'outdent', 'move_up', 'move_down'],
          description: 'User-like structural command for one or more nodes, matching keyboard operations on selected rows.',
        },
      },
    },
    merge_from_node_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string', minLength: 1 },
      description: 'Source node ids to merge into node_id. Children, fields, tags, and references are merged into the target; source nodes are then moved to Trash.',
    },
    replace_with_reference_to: {
      type: 'string',
      minLength: 1,
      description: 'Replace node_id with a reference to this target node id at the same position.',
    },
    preview_only: {
      type: 'boolean',
      description: 'Validate and render before/after data only; do not mutate the document.',
    },
  },
};

export const OPERATION_HISTORY_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'undo', 'redo'],
      description: 'History action. Defaults to list. list is read-only; undo and redo operate on the selected operation stack.',
    },
    steps: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'Number of operation stack steps for undo or redo. Default 1, max 10.',
    },
    operation_id: {
      type: 'string',
      minLength: 1,
      description: 'Optional stack-top guard from operation_history list. Undo/redo is skipped unless the current stack top has this operation_id.',
    },
    origin: {
      type: 'string',
      enum: ['all', 'agent', 'user'],
      description: 'Filter for list and target stack for undo/redo. Defaults to all for list and agent for undo/redo.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Maximum history items to return. Default 20, max 100.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'Skip the first N history items before returning results. Default 0.',
    },
  },
};
