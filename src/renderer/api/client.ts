import type {
  Backlink,
  AgentProviderConfigInput,
  AgentProviderSecretStatus,
  AgentProviderSettingsView,
  AgentSession,
  AgentSessionMeta,
  CommandOutcome,
  CreateNodeTree,
  DocumentProjection,
  FieldConfigPatch,
  FieldType,
  FilterOp,
  RichText,
  RichTextPatch,
  SearchHit,
  SortDirection,
  TagConfigPatch,
} from './types';
import { replaceAllRichTextPatch } from './types';
import type { AgentDebugSnapshot, AgentDebugTotals, AgentMessageAttachmentInput } from '../../core/agentTypes';

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (window.lin) return window.lin.invoke<T>(name, args);
  return Promise.reject(new Error('Lin desktop bridge is unavailable'));
}

export const api = {
  initWorkspace: () => command<DocumentProjection>('init_workspace'),
  getProjection: () => command<DocumentProjection>('get_projection'),
  createNode: (parentId: string, index: number | null, text: string) =>
    command<CommandOutcome>('create_node', { parentId, index, text }),
  createNodesFromTree: (parentId: string, nodes: CreateNodeTree[]) =>
    command<CommandOutcome>('create_nodes_from_tree', { parentId, nodes }),
  pasteNodesIntoNode: (
    nodeId: string,
    content: RichText,
    children: CreateNodeTree[],
    siblingsAfter: CreateNodeTree[],
  ) => command<CommandOutcome>('paste_nodes_into_node', {
    nodeId,
    content,
    children,
    siblingsAfter,
  }),
  splitNode: (nodeId: string, before: RichText, after: RichText) =>
    command<CommandOutcome>('split_node', { nodeId, before, after }),
  applyNodeTextPatch: (nodeId: string, patch: RichTextPatch) =>
    command<CommandOutcome>('apply_node_text_patch', { nodeId, patch }),
  replaceNodeText: (nodeId: string, content: RichText) =>
    command<CommandOutcome>('apply_node_text_patch', { nodeId, patch: replaceAllRichTextPatch(content) }),
  updateNodeDescription: (nodeId: string, description: string | null) =>
    command<CommandOutcome>('update_node_description', { nodeId, description }),
  setNodeCheckboxVisible: (nodeId: string, visible: boolean) =>
    command<CommandOutcome>('set_node_checkbox_visible', { nodeId, visible }),
  setNodeToolbarVisible: (nodeId: string, visible: boolean) =>
    command<CommandOutcome>('set_node_toolbar_visible', { nodeId, visible }),
  setNodeSort: (nodeId: string, field: string | null, direction: SortDirection | null = null) =>
    command<CommandOutcome>('set_node_sort', { nodeId, field, direction }),
  setNodeFilter: (
    nodeId: string,
    field: string | null,
    op: FilterOp | null = null,
    values: string[] = [],
  ) => command<CommandOutcome>('set_node_filter', { nodeId, field, op, values }),
  setNodeGroup: (nodeId: string, field: string | null) =>
    command<CommandOutcome>('set_node_group', { nodeId, field }),
  mergeNodeInto: (nodeId: string, targetId: string) =>
    command<CommandOutcome>('merge_node_into', { nodeId, targetId }),
  moveNode: (nodeId: string, parentId: string, index: number | null = null) =>
    command<CommandOutcome>('move_node', { nodeId, parentId, index }),
  indentNode: (nodeId: string) => command<CommandOutcome>('indent_node', { nodeId }),
  outdentNode: (nodeId: string) => command<CommandOutcome>('outdent_node', { nodeId }),
  trashNode: (nodeId: string) => command<CommandOutcome>('trash_node', { nodeId }),
  batchTrashNodes: (nodeIds: string[]) => command<CommandOutcome>('batch_trash_nodes', { nodeIds }),
  batchIndentNodes: (nodeIds: string[]) => command<CommandOutcome>('batch_indent_nodes', { nodeIds }),
  batchOutdentNodes: (nodeIds: string[]) => command<CommandOutcome>('batch_outdent_nodes', { nodeIds }),
  batchToggleDone: (nodeIds: string[]) => command<CommandOutcome>('batch_toggle_done', { nodeIds }),
  batchCycleDoneState: (nodeIds: string[]) => command<CommandOutcome>('batch_cycle_done_state', { nodeIds }),
  batchDuplicateNodes: (nodeIds: string[]) => command<CommandOutcome>('batch_duplicate_nodes', { nodeIds }),
  batchMoveNodesUp: (nodeIds: string[]) => command<CommandOutcome>('batch_move_nodes_up', { nodeIds }),
  batchMoveNodesDown: (nodeIds: string[]) => command<CommandOutcome>('batch_move_nodes_down', { nodeIds }),
  batchApplyTag: (nodeIds: string[], tagId: string) =>
    command<CommandOutcome>('batch_apply_tag', { nodeIds, tagId }),
  restoreNode: (nodeId: string) => command<CommandOutcome>('restore_node', { nodeId }),
  deleteNode: (nodeId: string) => command<CommandOutcome>('delete_node', { nodeId }),
  toggleDone: (nodeId: string) => command<CommandOutcome>('toggle_done', { nodeId }),
  cycleDoneState: (nodeId: string) => command<CommandOutcome>('cycle_done_state', { nodeId }),
  createTag: (name: string) => command<CommandOutcome>('create_tag', { name }),
  applyTag: (nodeId: string, tagId: string) =>
    command<CommandOutcome>('apply_tag', { nodeId, tagId }),
  removeTag: (nodeId: string, tagId: string) =>
    command<CommandOutcome>('remove_tag', { nodeId, tagId }),
  setTagConfig: (tagId: string, patch: TagConfigPatch) =>
    command<CommandOutcome>('set_tag_config', { tagId, patch }),
  setFieldConfig: (fieldId: string, patch: FieldConfigPatch) =>
    command<CommandOutcome>('set_field_config', { fieldId, patch }),
  createFieldDef: (tagId: string, name: string, fieldType: FieldType) =>
    command<CommandOutcome>('create_field_def', { tagId, name, fieldType }),
  createInlineFieldAfterNode: (afterNodeId: string, name: string, fieldType: FieldType) =>
    command<CommandOutcome>('create_inline_field_after_node', { afterNodeId, name, fieldType }),
  createInlineField: (parentId: string, index: number | null, name: string, fieldType: FieldType) =>
    command<CommandOutcome>('create_inline_field', { parentId, index, name, fieldType }),
  registerCollectedOption: (fieldDefId: string, name: string) =>
    command<CommandOutcome>('register_collected_option', { fieldDefId, name }),
  selectFieldOption: (fieldEntryId: string, optionNodeId: string) =>
    command<CommandOutcome>('select_field_option', { fieldEntryId, optionNodeId }),
  addReference: (parentId: string, targetId: string, index: number | null = null) =>
    command<CommandOutcome>('add_reference', { parentId, targetId, index }),
  setReferenceTarget: (referenceId: string, targetId: string) =>
    command<CommandOutcome>('set_reference_target', { referenceId, targetId }),
  replaceNodeWithReference: (nodeId: string, targetId: string) =>
    command<CommandOutcome>('replace_node_with_reference', { nodeId, targetId }),
  ensureDateNode: (year: number, month: number, day: number) =>
    command<CommandOutcome>('ensure_date_node', { year, month, day }),
  searchNodes: (query: string) => command<SearchHit[]>('search_nodes', { query }),
  ensureTagSearch: (tagId: string) => command<CommandOutcome>('ensure_tag_search', { tagId }),
  backlinks: (targetId: string) => command<Backlink[]>('backlinks', { targetId }),
  undo: () => command<CommandOutcome>('undo'),
  redo: () => command<CommandOutcome>('redo'),
  agentRestoreLatestSession: () => command<AgentSession>('agent_restore_latest_session'),
  agentRestoreSession: (sessionId: string) => command<AgentSession>('agent_restore_session', { sessionId }),
  agentCreateSession: () => command<AgentSession>('agent_create_session'),
  agentListSessions: () => command<AgentSessionMeta[]>('agent_list_sessions'),
  agentRenameSession: (sessionId: string, title: string) =>
    command<AgentSessionMeta | null>('agent_rename_session', { sessionId, title }),
  agentDeleteSession: (sessionId: string) =>
    command<void>('agent_delete_session', { sessionId }),
  agentDebugSnapshot: (sessionId: string) =>
    command<AgentDebugSnapshot | null>('agent_debug_snapshot', { sessionId }),
  agentDebugHistory: (sessionId: string) =>
    command<AgentDebugSnapshot[]>('agent_debug_history', { sessionId }),
  agentDebugTotals: (sessionId: string) =>
    command<AgentDebugTotals>('agent_debug_totals', { sessionId }),
  agentSendMessage: (sessionId: string, message: string, attachments: AgentMessageAttachmentInput[] = []) =>
    command<void>('agent_send_message', { sessionId, message, attachments }),
  agentEditMessage: (sessionId: string, nodeId: string, message: string) =>
    command<void>('agent_edit_message', { sessionId, nodeId, message }),
  agentRegenerateMessage: (sessionId: string, nodeId: string) =>
    command<void>('agent_regenerate_message', { sessionId, nodeId }),
  agentRetryMessage: (sessionId: string, nodeId: string) =>
    command<void>('agent_retry_message', { sessionId, nodeId }),
  agentSwitchBranch: (sessionId: string, nodeId: string) =>
    command<void>('agent_switch_branch', { sessionId, nodeId }),
  agentQueueFollowUp: (sessionId: string, message: string) =>
    command<{ queued: boolean }>('agent_queue_follow_up', { sessionId, message }),
  agentClearFollowUp: (sessionId: string) =>
    command<void>('agent_clear_follow_up', { sessionId }),
  agentStopSession: (sessionId: string) =>
    command<void>('agent_stop_session', { sessionId }),
  agentResetSession: (sessionId: string) =>
    command<void>('agent_reset_session', { sessionId }),
  agentCloseSession: (sessionId: string) =>
    command<void>('agent_close_session', { sessionId }),
  agentGetProviderSettings: () =>
    command<AgentProviderSettingsView>('agent_get_provider_settings'),
  agentUpsertProviderConfig: (provider: AgentProviderConfigInput) =>
    command<AgentProviderSettingsView>('agent_upsert_provider_config', { provider }),
  agentDeleteProviderConfig: (providerId: string) =>
    command<AgentProviderSettingsView>('agent_delete_provider_config', { providerId }),
  agentSetActiveProvider: (providerId: string) =>
    command<AgentProviderSettingsView>('agent_set_active_provider', { providerId }),
  agentSetProviderApiKey: (providerId: string, apiKey: string) =>
    command<AgentProviderSecretStatus>('agent_set_provider_api_key', { providerId, apiKey }),
  agentDeleteProviderApiKey: (providerId: string) =>
    command<AgentProviderSecretStatus>('agent_delete_provider_api_key', { providerId }),
  agentGetProviderSecretStatus: (providerId: string) =>
    command<AgentProviderSecretStatus>('agent_get_provider_secret_status', { providerId }),
};
