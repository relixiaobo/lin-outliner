import type {
  Backlink,
  AgentProviderConfigInput,
  AgentProviderSecretStatus,
  AgentProviderSettingsView,
  AgentRuntimeSettingsInput,
  AgentSession,
  AgentSessionMeta,
  CommandOutcome,
  CreateNodeTree,
  DocumentProjection,
  FieldConfigPatch,
  FieldType,
  FilterOperator,
  FilterValueLogic,
  IconKind,
  RichText,
  RichTextPatch,
  SearchHit,
  SplitNodeOptions,
  SortDirection,
  TagConfigPatch,
  ViewMode,
} from './types';
import { replaceAllRichTextPatch } from './types';
import type {
  AgentDebugSnapshot,
  AgentDebugTotals,
  AgentMessageAttachmentInput,
  AgentSubagentActionResult,
  AgentUserViewContext,
} from '../../core/agentTypes';

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (window.lin) return window.lin.invoke<T>(name, args);
  return Promise.reject(new Error('Lin desktop bridge is unavailable'));
}

export const api = {
  initWorkspace: () => command<DocumentProjection>('init_workspace'),
  getProjection: () => command<DocumentProjection>('get_projection'),
  createNode: (parentId: string, index: number | null, text: string) =>
    command<CommandOutcome>('create_node', { parentId, index, text }),
  createRichTextNode: (parentId: string, index: number | null, content: RichText) =>
    command<CommandOutcome>('create_rich_text_node', { parentId, index, content }),
  createTaggedNode: (parentId: string, content: RichText, tagId: string) =>
    command<CommandOutcome>('create_tagged_node', { parentId, content, tagId }),
  createTagAndTaggedNode: (parentId: string, content: RichText, name: string) =>
    command<CommandOutcome>('create_tag_and_tagged_node', { parentId, content, name }),
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
  splitNode: (nodeId: string, before: RichText, after: RichText, options: SplitNodeOptions = {}) =>
    command<CommandOutcome>('split_node', { nodeId, before, after, ...options }),
  applyNodeTextPatch: (nodeId: string, patch: RichTextPatch) =>
    command<CommandOutcome>('apply_node_text_patch', { nodeId, patch }),
  replaceNodeText: (nodeId: string, content: RichText) =>
    command<CommandOutcome>('apply_node_text_patch', { nodeId, patch: replaceAllRichTextPatch(content) }),
  updateNodeDescription: (nodeId: string, description: string | null) =>
    command<CommandOutcome>('update_node_description', { nodeId, description }),
  setNodeCheckboxVisible: (nodeId: string, visible: boolean) =>
    command<CommandOutcome>('set_node_checkbox_visible', { nodeId, visible }),
  setViewToolbarVisible: (nodeId: string, visible: boolean) =>
    command<CommandOutcome>('set_view_toolbar_visible', { nodeId, visible }),
  setViewMode: (nodeId: string, mode: ViewMode) =>
    command<CommandOutcome>('set_view_mode', { nodeId, mode }),
  addSortRule: (nodeId: string, field: string, direction: SortDirection = 'asc') =>
    command<CommandOutcome>('add_sort_rule', { nodeId, field, direction }),
  updateSortRule: (ruleId: string, field: string, direction: SortDirection = 'asc') =>
    command<CommandOutcome>('update_sort_rule', { ruleId, field, direction }),
  removeSortRule: (ruleId: string) =>
    command<CommandOutcome>('remove_sort_rule', { ruleId }),
  clearSortRules: (nodeId: string) =>
    command<CommandOutcome>('clear_sort_rules', { nodeId }),
  addFilterRule: (
    nodeId: string,
    field: string,
    operator: FilterOperator = 'contains',
    values: string[] = [],
    valueLogic: FilterValueLogic = 'any',
  ) => command<CommandOutcome>('add_filter_rule', { nodeId, field, operator, values, valueLogic }),
  updateFilterRule: (
    ruleId: string,
    patch: { field?: string | null; operator?: FilterOperator | null; values?: string[] | null; valueLogic?: FilterValueLogic | null },
  ) => command<CommandOutcome>('update_filter_rule', { ruleId, ...patch }),
  removeFilterRule: (ruleId: string) =>
    command<CommandOutcome>('remove_filter_rule', { ruleId }),
  clearFilterRules: (nodeId: string) =>
    command<CommandOutcome>('clear_filter_rules', { nodeId }),
  setGroupField: (nodeId: string, field: string | null) =>
    command<CommandOutcome>('set_group_field', { nodeId, field }),
  addDisplayField: (nodeId: string, field: string) =>
    command<CommandOutcome>('add_display_field', { nodeId, field }),
  updateDisplayField: (
    displayFieldId: string,
    patch: { field?: string | null; visible?: boolean | null; width?: number | null; order?: number | null; label?: string | null; placement?: string | null },
  ) => command<CommandOutcome>('update_display_field', { displayFieldId, ...patch }),
  removeDisplayField: (displayFieldId: string) =>
    command<CommandOutcome>('remove_display_field', { displayFieldId }),
  setNodeIcon: (nodeId: string, icon: string | null, iconKind: IconKind | null = null) =>
    command<CommandOutcome>('set_node_icon', { nodeId, icon, iconKind }),
  setNodeBanner: (nodeId: string, assetId: string | null, position?: { x?: number | null; y?: number | null }) =>
    command<CommandOutcome>('set_node_banner', { nodeId, assetId, positionX: position?.x, positionY: position?.y }),
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
  createCollectedFieldOption: (fieldEntryId: string, name: string) =>
    command<CommandOutcome>('create_collected_field_option', { fieldEntryId, name }),
  selectFieldOption: (fieldEntryId: string, optionNodeId: string) =>
    command<CommandOutcome>('select_field_option', { fieldEntryId, optionNodeId }),
  clearFieldValue: (fieldEntryId: string) =>
    command<CommandOutcome>('clear_field_value', { fieldEntryId }),
  addReference: (parentId: string, targetId: string, index: number | null = null) =>
    command<CommandOutcome>('add_reference', { parentId, targetId, index }),
  addReferenceConversion: (parentId: string, targetId: string, index: number | null = null) =>
    command<CommandOutcome>('add_reference_conversion', { parentId, targetId, index }),
  setReferenceTarget: (referenceId: string, targetId: string) =>
    command<CommandOutcome>('set_reference_target', { referenceId, targetId }),
  replaceNodeWithReference: (nodeId: string, targetId: string) =>
    command<CommandOutcome>('replace_node_with_reference', { nodeId, targetId }),
  replaceNodeWithReferenceConversion: (nodeId: string, targetId: string) =>
    command<CommandOutcome>('replace_node_with_reference_conversion', { nodeId, targetId }),
  replaceNodeWithInlineReference: (nodeId: string, targetId: string) =>
    command<CommandOutcome>('replace_node_with_inline_reference', { nodeId, targetId }),
  convertReferenceToInlineNode: (referenceId: string) =>
    command<CommandOutcome>('convert_reference_to_inline_node', { referenceId }),
  restoreInlineReferenceNodeToReference: (nodeId: string, targetId: string) =>
    command<CommandOutcome>('restore_inline_reference_node_to_reference', { nodeId, targetId }),
  ensureDateNode: (year: number, month: number, day: number) =>
    command<CommandOutcome>('ensure_date_node', { year, month, day }),
  searchNodes: (query: string) => command<SearchHit[]>('search_nodes', { query }),
  ensureTagSearch: (tagId: string) => command<CommandOutcome>('ensure_tag_search', { tagId }),
  setSearchQueryOutline: (nodeId: string, queryOutline: string) =>
    command<CommandOutcome>('set_search_query_outline', { nodeId, queryOutline }),
  refreshSearchNodeResults: (nodeId: string) =>
    command<CommandOutcome>('refresh_search_node_results', { nodeId }),
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
  agentDebugPayload: (sessionId: string, payloadId: string) =>
    command<string | null>('agent_debug_payload', { sessionId, payloadId }),
  agentPayloadText: (sessionId: string, payloadId: string) =>
    command<string | null>('agent_payload_text', { sessionId, payloadId }),
  agentSubagentStatus: (sessionId: string, agentId: string, options: { wait?: boolean; timeoutMs?: number } = {}) =>
    command<AgentSubagentActionResult>('agent_subagent_status', { sessionId, agentId, ...options }),
  agentSubagentSend: (sessionId: string, agentId: string, message: string) =>
    command<AgentSubagentActionResult>('agent_subagent_send', { sessionId, agentId, message }),
  agentSubagentStop: (sessionId: string, agentId: string) =>
    command<AgentSubagentActionResult>('agent_subagent_stop', { sessionId, agentId }),
  agentSendMessage: (
    sessionId: string,
    message: string,
    attachments: AgentMessageAttachmentInput[] = [],
    userViewContext?: AgentUserViewContext | null,
  ) => command<void>('agent_send_message', { sessionId, message, attachments, userViewContext }),
  agentEditMessage: (sessionId: string, nodeId: string, message: string) =>
    command<void>('agent_edit_message', { sessionId, nodeId, message }),
  agentRegenerateMessage: (sessionId: string, nodeId: string) =>
    command<void>('agent_regenerate_message', { sessionId, nodeId }),
  agentRetryMessage: (sessionId: string, nodeId: string) =>
    command<void>('agent_retry_message', { sessionId, nodeId }),
  agentSwitchBranch: (sessionId: string, nodeId: string) =>
    command<void>('agent_switch_branch', { sessionId, nodeId }),
  agentQueueFollowUp: (
    sessionId: string,
    message: string,
    userViewContext?: AgentUserViewContext | null,
  ) => command<{ queued: boolean }>('agent_queue_follow_up', { sessionId, message, userViewContext }),
  agentClearFollowUp: (sessionId: string) =>
    command<void>('agent_clear_follow_up', { sessionId }),
  agentSteerSession: (sessionId: string, message: string) =>
    command<{ queued: boolean }>('agent_steer_session', { sessionId, message }),
  agentClearSteer: (sessionId: string) =>
    command<void>('agent_clear_steer', { sessionId }),
  agentStopSession: (sessionId: string) =>
    command<void>('agent_stop_session', { sessionId }),
  agentResetSession: (sessionId: string) =>
    command<void>('agent_reset_session', { sessionId }),
  agentCloseSession: (sessionId: string) =>
    command<void>('agent_close_session', { sessionId }),
  agentGetProviderSettings: () =>
    command<AgentProviderSettingsView>('agent_get_provider_settings'),
  agentUpdateRuntimeSettings: (settings: AgentRuntimeSettingsInput) =>
    command<AgentProviderSettingsView>('agent_update_runtime_settings', { settings }),
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
