import type {
  AssetMetadata,
  Backlink,
  AgentProviderConfigInput,
  AgentProviderSecretStatus,
  AgentProviderStoredApiKey,
  AgentProviderSettingsView,
  AgentImageGenerationSettingsInput,
  AgentRuntimeSettingsInput,
  AgentConversation,
  AgentCreateConversationOptions,
  AgentConversationListMeta,
  AgentDreamReadiness,
  AgentRenderDreamRunEntity,
  AgentRunListEntry,
  IssueReadInput,
  IssueReadResult,
  IssueSearchInput,
  IssueSearchResult,
  AgentPickScopeFolderResult,
  AgentSlashCommandView,
  AgentApprovalResolutionScope,
  AgentToolPermissionSettingsInput,
  AgentToolPermissionSettingsView,
  AgentDefinition,
  AgentDefinitionView,
  AgentAuthoringInput,
  AgentStorageLocation,
  SkillDefinition,
  CommandResult,
  CreateNodeTree,
  BatchMoveNodeInput,
  PasteRowMeta,
  DocumentProjection,
  ProjectionSnapshot,
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
  AgentDebugConversation,
  AgentDebugRun,
  AgentMessageAttachmentInput,
  AgentRunActionResult,
  AgentRunDetailPayload,
  AgentRunTranscriptPayload,
  AgentUserViewContext,
  AskUserQuestionResult,
} from '../../core/agentTypes';
import type {
  PreviewListDirectoryResult,
  PreviewReadBytesResult,
  PreviewReadTextResult,
  PreviewResolveSourceResult,
  PreviewTarget,
} from '../../core/preview';

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (window.lin) return window.lin.invoke<T>(name, args);
  return Promise.reject(new Error('Tenon desktop bridge is unavailable'));
}

function bridge<T>(fn: (lin: NonNullable<typeof window.lin>) => Promise<T>): Promise<T> {
  if (window.lin) return fn(window.lin);
  return Promise.reject(new Error('Tenon desktop bridge is unavailable'));
}

export const api = {
  initWorkspace: () => command<ProjectionSnapshot>('init_workspace'),
  recordNodeAccess: (nodeId: string) => bridge((lin) => lin.recordNodeAccess(nodeId)),
  getProjection: () => command<ProjectionSnapshot>('get_projection'),
  createNode: (parentId: string, index: number | null, text: string, id?: string) =>
    command<CommandResult>('create_node', { parentId, index, text, id }),
  // Eager materialization: turn a renderer-only draft row into a real node under
  // the client-proposed `id`. `materialize: true` makes the create open an undo
  // group that the following text patches join (one undo step for the new row).
  materializeDraftNode: (parentId: string, index: number | null, text: string, id: string) =>
    command<CommandResult>('create_node', { parentId, index, text, id, materialize: true }),
  createRichTextNode: (parentId: string, index: number | null, content: RichText) =>
    command<CommandResult>('create_rich_text_node', { parentId, index, content }),
  createTaggedNode: (parentId: string, content: RichText, tagId: string) =>
    command<CommandResult>('create_tagged_node', { parentId, content, tagId }),
  createTagAndTaggedNode: (parentId: string, content: RichText, name: string) =>
    command<CommandResult>('create_tag_and_tagged_node', { parentId, content, name }),
  createNodesFromTree: (parentId: string, nodes: CreateNodeTree[]) =>
    command<CommandResult>('create_nodes_from_tree', { parentId, nodes }),
  pasteNodesIntoNode: (
    nodeId: string,
    content: RichText,
    children: CreateNodeTree[],
    siblingsAfter: CreateNodeTree[],
    firstMeta: PasteRowMeta = {},
  ) => command<CommandResult>('paste_nodes_into_node', {
    nodeId,
    content,
    children,
    siblingsAfter,
    firstMeta,
  }),
  splitNode: (nodeId: string, before: RichText, after: RichText, options: SplitNodeOptions = {}) =>
    command<CommandResult>('split_node', { nodeId, before, after, ...options }),
  applyNodeTextPatch: (nodeId: string, patch: RichTextPatch) =>
    command<CommandResult>('apply_node_text_patch', { nodeId, patch }),
  replaceNodeText: (nodeId: string, content: RichText) =>
    command<CommandResult>('apply_node_text_patch', { nodeId, patch: replaceAllRichTextPatch(content) }),
  updateNodeDescription: (nodeId: string, description: string | null) =>
    command<CommandResult>('update_node_description', { nodeId, description }),
  setNodeCheckboxVisible: (nodeId: string, visible: boolean) =>
    command<CommandResult>('set_node_checkbox_visible', { nodeId, visible }),
  setCodeBlock: (nodeId: string, codeLanguage?: string) =>
    command<CommandResult>('set_code_block', { nodeId, codeLanguage: codeLanguage ?? null }),
  setCodeLanguage: (nodeId: string, codeLanguage: string) =>
    command<CommandResult>('set_code_language', { nodeId, codeLanguage }),
  // An image node's source is exactly one of `assetId` (local) or `mediaUrl`
  // (remote); the core validates that.
  createImageNode: (
    parentId: string,
    index: number | null,
    options: { assetId?: string; mediaUrl?: string; width?: number | null; height?: number | null; alt?: string | null; name?: string | null },
  ) => command<CommandResult>('create_image_node', { parentId, index, ...options }),
  createAttachmentNode: (
    parentId: string,
    index: number | null,
    options: {
      assetId: string;
      mimeType: string;
      originalFilename: string;
      fileSize: number;
      thumbnailAssetId?: string;
      pdfPageCount?: number;
      audioDurationMs?: number;
      videoDurationMs?: number;
    },
  ) => command<CommandResult>('create_attachment_node', { parentId, index, ...options }),
  setNodeImage: (
    nodeId: string,
    options: { assetId?: string; mediaUrl?: string; width?: number | null; height?: number | null },
  ) => command<CommandResult>('set_node_image', { nodeId, ...options }),
  // Renderer ingest is buffer-only by design; path ingest is a main-process
  // primitive (see pick_image_files) and is intentionally not exposed here.
  ingestAssetFromData: (data: Uint8Array, mimeType?: string, originalFilename?: string) =>
    command<AssetMetadata>('ingest_asset', { kind: 'buffer', data, mimeType, originalFilename }),
  // The ingest bridge: copy+freeze an agent working file into the asset store. The
  // path is path-ingested in main but only if it resolves inside the agent's trusted
  // roots (workdir/scratch) -- the same gate that backs previewing these chips -- so
  // this is not the arbitrary-path read the buffer-only rule above guards against.
  // Returns null when the path is not a trusted file (e.g. GC'd working file).
  ingestLocalFileToAsset: (path: string) =>
    command<AssetMetadata | null>('ingest_local_file', { path }),
  lookupAsset: (id: string) => command<AssetMetadata | null>('lookup_asset', { id }),
  deleteAsset: (id: string) => command<void>('delete_asset', { id }),
  pickImageFiles: () => command<AssetMetadata[]>('pick_image_files'),
  pickAttachmentFiles: () => command<AssetMetadata[]>('pick_attachment_files'),
  openAsset: (id: string) => command<{ opened: boolean }>('open_asset', { id }),
  revealAsset: (id: string) => command<{ revealed: boolean }>('reveal_asset', { id }),
  copyAssetFile: (id: string) => command<{ copied: boolean }>('copy_asset_file', { id }),
  openExternalUrl: (url: string) => command<{ opened: boolean }>('open_external_url', { url }),
  resolvePreviewSource: (target: PreviewTarget) =>
    command<PreviewResolveSourceResult>('preview_resolve_source', { target }),
  readPreviewText: (target: PreviewTarget) =>
    command<PreviewReadTextResult>('preview_read_text', { target }),
  readPreviewBytes: (target: PreviewTarget) =>
    command<PreviewReadBytesResult>('preview_read_bytes', { target }),
  listPreviewDirectory: (target: PreviewTarget) =>
    command<PreviewListDirectoryResult>('preview_list_directory', { target }),
  setViewToolbarVisible: (nodeId: string, visible: boolean) =>
    command<CommandResult>('set_view_toolbar_visible', { nodeId, visible }),
  setViewMode: (nodeId: string, mode: ViewMode) =>
    command<CommandResult>('set_view_mode', { nodeId, mode }),
  addSortRule: (nodeId: string, field: string, direction: SortDirection = 'asc') =>
    command<CommandResult>('add_sort_rule', { nodeId, field, direction }),
  updateSortRule: (ruleId: string, field: string, direction: SortDirection = 'asc') =>
    command<CommandResult>('update_sort_rule', { ruleId, field, direction }),
  removeSortRule: (ruleId: string) =>
    command<CommandResult>('remove_sort_rule', { ruleId }),
  clearSortRules: (nodeId: string) =>
    command<CommandResult>('clear_sort_rules', { nodeId }),
  addFilterRule: (
    nodeId: string,
    field: string,
    operator: FilterOperator = 'contains',
    values: string[] = [],
    valueLogic: FilterValueLogic = 'any',
  ) => command<CommandResult>('add_filter_rule', { nodeId, field, operator, values, valueLogic }),
  updateFilterRule: (
    ruleId: string,
    patch: { field?: string | null; operator?: FilterOperator | null; values?: string[] | null; valueLogic?: FilterValueLogic | null },
  ) => command<CommandResult>('update_filter_rule', { ruleId, ...patch }),
  removeFilterRule: (ruleId: string) =>
    command<CommandResult>('remove_filter_rule', { ruleId }),
  clearFilterRules: (nodeId: string) =>
    command<CommandResult>('clear_filter_rules', { nodeId }),
  setGroupField: (nodeId: string, field: string | null) =>
    command<CommandResult>('set_group_field', { nodeId, field }),
  addDisplayField: (nodeId: string, field: string) =>
    command<CommandResult>('add_display_field', { nodeId, field }),
  updateDisplayField: (
    displayFieldId: string,
    patch: { field?: string | null; visible?: boolean | null; width?: number | null; order?: number | null; label?: string | null; placement?: string | null },
  ) => command<CommandResult>('update_display_field', { displayFieldId, ...patch }),
  removeDisplayField: (displayFieldId: string) =>
    command<CommandResult>('remove_display_field', { displayFieldId }),
  setNodeIcon: (nodeId: string, icon: string | null, iconKind: IconKind | null = null) =>
    command<CommandResult>('set_node_icon', { nodeId, icon, iconKind }),
  setNodeBanner: (nodeId: string, assetId: string | null, position?: { x?: number | null; y?: number | null }) =>
    command<CommandResult>('set_node_banner', { nodeId, assetId, positionX: position?.x, positionY: position?.y }),
  mergeNodeInto: (nodeId: string, targetId: string) =>
    command<CommandResult>('merge_node_into', { nodeId, targetId }),
  moveNode: (nodeId: string, parentId: string, index: number | null = null) =>
    command<CommandResult>('move_node', { nodeId, parentId, index }),
  batchMoveNodes: (moves: readonly BatchMoveNodeInput[]) =>
    command<CommandResult>('batch_move_nodes', { moves }),
  indentNode: (nodeId: string) => command<CommandResult>('indent_node', { nodeId }),
  outdentNode: (nodeId: string) => command<CommandResult>('outdent_node', { nodeId }),
  trashNode: (nodeId: string) => command<CommandResult>('trash_node', { nodeId }),
  batchTrashNodes: (nodeIds: string[]) => command<CommandResult>('batch_trash_nodes', { nodeIds }),
  batchIndentNodes: (nodeIds: string[]) => command<CommandResult>('batch_indent_nodes', { nodeIds }),
  batchOutdentNodes: (nodeIds: string[]) => command<CommandResult>('batch_outdent_nodes', { nodeIds }),
  batchToggleDone: (nodeIds: string[]) => command<CommandResult>('batch_toggle_done', { nodeIds }),
  batchCycleDoneState: (nodeIds: string[]) => command<CommandResult>('batch_cycle_done_state', { nodeIds }),
  batchDuplicateNodes: (nodeIds: string[]) => command<CommandResult>('batch_duplicate_nodes', { nodeIds }),
  batchMoveNodesUp: (nodeIds: string[]) => command<CommandResult>('batch_move_nodes_up', { nodeIds }),
  batchMoveNodesDown: (nodeIds: string[]) => command<CommandResult>('batch_move_nodes_down', { nodeIds }),
  batchApplyTag: (nodeIds: string[], tagId: string) =>
    command<CommandResult>('batch_apply_tag', { nodeIds, tagId }),
  restoreNode: (nodeId: string) => command<CommandResult>('restore_node', { nodeId }),
  deleteNode: (nodeId: string) => command<CommandResult>('delete_node', { nodeId }),
  toggleDone: (nodeId: string) => command<CommandResult>('toggle_done', { nodeId }),
  cycleDoneState: (nodeId: string) => command<CommandResult>('cycle_done_state', { nodeId }),
  createTag: (name: string) => command<CommandResult>('create_tag', { name }),
  applyTag: (nodeId: string, tagId: string) =>
    command<CommandResult>('apply_tag', { nodeId, tagId }),
  removeTag: (nodeId: string, tagId: string) =>
    command<CommandResult>('remove_tag', { nodeId, tagId }),
  setTagConfig: (tagId: string, patch: TagConfigPatch) =>
    command<CommandResult>('set_tag_config', { tagId, patch }),
  setFieldConfig: (fieldId: string, patch: FieldConfigPatch) =>
    command<CommandResult>('set_field_config', { fieldId, patch }),
  createFieldDef: (tagId: string, name: string, fieldType: FieldType) =>
    command<CommandResult>('create_field_def', { tagId, name, fieldType }),
  createInlineFieldAfterNode: (afterNodeId: string, name: string, fieldType: FieldType) =>
    command<CommandResult>('create_inline_field_after_node', { afterNodeId, name, fieldType }),
  createInlineField: (parentId: string, index: number | null, name: string, fieldType: FieldType) =>
    command<CommandResult>('create_inline_field', { parentId, index, name, fieldType }),
  reuseFieldDefinition: (entryId: string, targetDefId: string) =>
    command<CommandResult>('reuse_field_definition', { entryId, targetDefId }),
  registerCollectedOption: (fieldDefId: string, name: string) =>
    command<CommandResult>('register_collected_option', { fieldDefId, name }),
  // `id` (optional) lets the renderer propose the trailing draft row's stable id
  // so the row's React identity (and any in-flight IME composition) survives the
  // draft->value materialization — the same contract as materializeDraftNode.
  createCollectedFieldOption: (fieldEntryId: string, name: string, id?: string) =>
    command<CommandResult>('create_collected_field_option', { fieldEntryId, name, id }),
  selectFieldOption: (fieldEntryId: string, optionNodeId: string, id?: string) =>
    command<CommandResult>('select_field_option', { fieldEntryId, optionNodeId, id }),
  addFieldReference: (fieldEntryId: string, targetNodeId: string, id?: string) =>
    command<CommandResult>('add_field_reference', { fieldEntryId, targetNodeId, id }),
  setFieldFreeTextValue: (fieldEntryId: string, text: string, id?: string) =>
    command<CommandResult>('set_field_free_text_value', { fieldEntryId, text, id }),
  clearFieldValue: (fieldEntryId: string) =>
    command<CommandResult>('clear_field_value', { fieldEntryId }),
  removeFieldValue: (valueId: string) =>
    command<CommandResult>('remove_field_value', { valueId }),
  addReference: (parentId: string, targetId: string, index: number | null = null) =>
    command<CommandResult>('add_reference', { parentId, targetId, index }),
  addReferenceConversion: (parentId: string, targetId: string, index: number | null = null) =>
    command<CommandResult>('add_reference_conversion', { parentId, targetId, index }),
  setReferenceTarget: (referenceId: string, targetId: string) =>
    command<CommandResult>('set_reference_target', { referenceId, targetId }),
  replaceNodeWithReference: (nodeId: string, targetId: string) =>
    command<CommandResult>('replace_node_with_reference', { nodeId, targetId }),
  replaceNodeWithReferenceConversion: (nodeId: string, targetId: string) =>
    command<CommandResult>('replace_node_with_reference_conversion', { nodeId, targetId }),
  replaceNodeWithInlineReference: (nodeId: string, targetId: string) =>
    command<CommandResult>('replace_node_with_inline_reference', { nodeId, targetId }),
  convertReferenceToInlineNode: (referenceId: string) =>
    command<CommandResult>('convert_reference_to_inline_node', { referenceId }),
  restoreInlineReferenceNodeToReference: (nodeId: string, targetId: string) =>
    command<CommandResult>('restore_inline_reference_node_to_reference', { nodeId, targetId }),
  ensureDateNode: (year: number, month: number, day: number) =>
    command<CommandResult>('ensure_date_node', { year, month, day }),
  searchNodes: (query: string) => command<SearchHit[]>('search_nodes', { query }),
  ensureTagSearch: (tagId: string) => command<CommandResult>('ensure_tag_search', { tagId }),
  setSearchQueryOutline: (nodeId: string, queryOutline: string) =>
    command<CommandResult>('set_search_query_outline', { nodeId, queryOutline }),
  refreshSearchNodeResults: (nodeId: string) =>
    command<CommandResult>('refresh_search_node_results', { nodeId }),
  backlinks: (targetId: string) => command<Backlink[]>('backlinks', { targetId }),
  undo: () => command<CommandResult>('undo'),
  redo: () => command<CommandResult>('redo'),
  agentRestoreLatestConversation: () => command<AgentConversation>('agent_restore_latest_conversation'),
  agentRestoreConversation: (conversationId: string) => (
    command<AgentConversation>('agent_restore_conversation', { conversationId })
  ),
  // Dedicated channel (not the agent-command union): durably mark a conversation
  // read when the user genuinely opens/views it. No-ops without the desktop bridge.
  agentMarkConversationRead: (conversationId: string): Promise<void> =>
    window.lin?.agentMarkConversationRead(conversationId) ?? Promise.resolve(),
  agentCreateConversation: (options: AgentCreateConversationOptions) =>
    command<AgentConversation>('agent_create_conversation', { ...options }),
  agentListConversations: () => command<AgentConversationListMeta[]>('agent_list_conversations'),
  agentRenameConversation: (conversationId: string, title: string) =>
    command<AgentConversationListMeta | null>('agent_rename_conversation', { conversationId, title }),
  agentSetConversationIncludeInDreamData: (conversationId: string, includeInDreamData: boolean) =>
    command<AgentConversationListMeta | null>('agent_set_conversation_include_in_dream_data', { conversationId, includeInDreamData }),
  agentDeleteConversation: (conversationId: string) =>
    command<void>('agent_delete_conversation', { conversationId }),
  agentListRuns: (options: { limit?: number; perConversationLimit?: number } = {}) =>
    command<AgentRunListEntry[]>('agent_list_runs', options),
  agentIssueSearch: (input: IssueSearchInput = {}) =>
    command<IssueSearchResult>('agent_issue_search', input as Record<string, unknown>),
  agentIssueRead: (input: IssueReadInput) =>
    command<IssueReadResult>('agent_issue_read', input as unknown as Record<string, unknown>),
  agentListDreamHistory: (options: { limit?: number } = {}) =>
    command<AgentRenderDreamRunEntity[]>('agent_list_dream_history', options),
  agentDreamReadiness: () =>
    command<AgentDreamReadiness>('agent_dream_readiness', {}),
  agentRunDreamNow: (options: { limit?: number; startDate?: string; endDate?: string; guidance?: string } = {}) =>
    command<AgentRenderDreamRunEntity[]>('agent_run_dream_now', options),
  agentDebugView: (conversationId: string) =>
    command<AgentDebugConversation>('agent_debug_view', { conversationId }),
  agentDebugRun: (conversationId: string, runId: string) =>
    command<AgentDebugRun | null>('agent_debug_run', { conversationId, runId }),
  agentPayloadText: (conversationId: string, payloadId: string) =>
    command<string | null>('agent_payload_text', { conversationId, payloadId }),
  agentRunDetail: (conversationId: string, runId: string) =>
    command<AgentRunDetailPayload | null>('agent_run_detail', { conversationId, runId }),
  agentRunTranscript: (conversationId: string, runId: string) =>
    command<AgentRunTranscriptPayload | null>('agent_run_transcript', { conversationId, runId }),
  agentRunConversationId: (runId: string) =>
    command<string | null>('agent_run_conversation_id', { runId }),
  agentRunStatus: (conversationId: string, runId: string, options: { wait?: boolean; timeoutMs?: number } = {}) =>
    command<AgentRunActionResult>('agent_run_status', { conversationId, runId, ...options }),
  agentRunSteer: (conversationId: string, runId: string, message: string) =>
    command<AgentRunActionResult>('agent_run_steer', { conversationId, runId, message }),
  agentRunAmend: (conversationId: string, runId: string, changes: unknown) =>
    command<AgentRunActionResult>('agent_run_amend', { conversationId, runId, changes }),
  agentRunStop: (conversationId: string, runId: string) =>
    command<AgentRunActionResult>('agent_run_stop', { conversationId, runId }),
  agentSendMessage: (
    conversationId: string,
    message: string,
    attachments: AgentMessageAttachmentInput[] = [],
    userViewContext?: AgentUserViewContext | null,
  ) => command<void>('agent_send_message', { conversationId, message, attachments, userViewContext }),
  agentEditMessage: (conversationId: string, nodeId: string, message: string) =>
    command<void>('agent_edit_message', { conversationId, nodeId, message }),
  agentRegenerateMessage: (conversationId: string, nodeId: string) =>
    command<void>('agent_regenerate_message', { conversationId, nodeId }),
  agentRetryMessage: (conversationId: string, nodeId: string) =>
    command<void>('agent_retry_message', { conversationId, nodeId }),
  agentSwitchBranch: (conversationId: string, nodeId: string) =>
    command<void>('agent_switch_branch', { conversationId, nodeId }),
  agentQueueFollowUp: (
    conversationId: string,
    message: string,
    userViewContext?: AgentUserViewContext | null,
  ) => command<{ queued: boolean }>('agent_queue_follow_up', { conversationId, message, userViewContext }),
  agentClearFollowUp: (conversationId: string) =>
    command<void>('agent_clear_follow_up', { conversationId }),
  agentSteerConversation: (conversationId: string, message: string) =>
    command<{ queued: boolean }>('agent_steer_conversation', { conversationId, message }),
  agentClearSteer: (conversationId: string) =>
    command<void>('agent_clear_steer', { conversationId }),
  agentResolveApproval: (
    conversationId: string,
    requestId: string,
    approved: boolean,
    scope: AgentApprovalResolutionScope = 'once',
  ) => command<{ resolved: boolean }>('agent_resolve_approval', { conversationId, requestId, approved, scope }),
  agentResolveUserQuestion: (
    conversationId: string,
    requestId: string,
    result: AskUserQuestionResult,
  ) => command<{ resolved: boolean }>('agent_resolve_user_question', { conversationId, requestId, result }),
  agentStopRun: (conversationId: string, runId: string) =>
    command<{ stopped: boolean }>('agent_stop_run', { conversationId, runId }),
  agentStopConversation: (conversationId: string) =>
    command<void>('agent_stop_conversation', { conversationId }),
  agentResetConversation: (conversationId: string) =>
    command<void>('agent_reset_conversation', { conversationId }),
  agentCloseConversation: (conversationId: string) =>
    command<void>('agent_close_conversation', { conversationId }),
  agentListSlashCommands: (conversationId: string) =>
    command<AgentSlashCommandView[]>('agent_list_slash_commands', { conversationId }),
  agentGetProviderSettings: () =>
    command<AgentProviderSettingsView>('agent_get_provider_settings'),
  agentRefreshProviderModels: (providerId: string) =>
    command<AgentProviderSettingsView>('agent_refresh_provider_models', { providerId }),
  agentUpdateRuntimeSettings: (settings: AgentRuntimeSettingsInput) =>
    command<AgentProviderSettingsView>('agent_update_runtime_settings', { settings }),
  agentUpdateImageGenerationSettings: (settings: AgentImageGenerationSettingsInput) =>
    command<AgentProviderSettingsView>('agent_update_image_generation_settings', { settings }),
  agentGetToolPermissionSettings: () =>
    command<AgentToolPermissionSettingsView>('agent_get_tool_permission_settings'),
  agentUpdateToolPermissionSettings: (settings: AgentToolPermissionSettingsInput) =>
    command<AgentToolPermissionSettingsView>('agent_update_tool_permission_settings', { settings }),
  agentAppendToolPermissionBlock: (ruleValue: string) =>
    command<AgentToolPermissionSettingsView>('agent_append_tool_permission_block', { ruleValue }),
  agentPickScopeFolder: (settings: AgentToolPermissionSettingsInput) =>
    command<AgentPickScopeFolderResult>('agent_pick_scope_folder', { settings }),
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
  agentGetProviderApiKey: (providerId: string) =>
    bridge((lin) => lin.getProviderApiKey(providerId)),
  agentOAuthLogin: (providerId: string) =>
    command<AgentProviderSettingsView>('agent_oauth_login', { providerId }),
  agentOAuthLogout: (providerId: string) =>
    command<AgentProviderSettingsView>('agent_oauth_logout', { providerId }),
  agentOAuthRespond: (requestId: string, value: string | undefined) =>
    command<void>('agent_oauth_respond', { requestId, value }),
  agentOAuthCancel: (providerId: string) =>
    command<void>('agent_oauth_cancel', { providerId }),
  agentListAllDefinitions: (conversationId: string) =>
    command<AgentDefinitionView[]>('agent_list_all_definitions', { conversationId }),
  agentTestProviderConnection: (options: { providerId: string; baseUrl?: string; apiKey?: string }) =>
    command<{ success: boolean; message: string; statusCode?: number }>('agent_test_provider_connection', options),
  agentListAllSkills: (conversationId: string) =>
    command<SkillDefinition[]>('agent_list_all_skills', { conversationId }),
  agentAcceptSkill: (conversationId: string, skillName: string, expectedHash: string) =>
    command<SkillDefinition[]>('agent_accept_skill', { conversationId, skillName, expectedHash }),
  agentRevokeSkillAcceptance: (conversationId: string, skillName: string) =>
    command<SkillDefinition[]>('agent_revoke_skill_acceptance', { conversationId, skillName }),
  agentUndoSkillAgentEdit: (conversationId: string, skillName: string) =>
    command<SkillDefinition[]>('agent_undo_skill_agent_edit', { conversationId, skillName }),
  agentUpdateAgentDefinition: (conversationId: string, agentId: string, input: AgentAuthoringInput) =>
    command<AgentDefinitionView[]>('agent_update_agent_definition', { conversationId, agentId, input }),
  agentReloadAgentDefinitions: (conversationId: string) =>
    command<AgentDefinitionView[]>('agent_reload_agent_definitions', { conversationId }),
};
