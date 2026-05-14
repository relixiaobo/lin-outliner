export const DOCUMENT_COMMANDS = [
  'init_workspace',
  'get_projection',
  'search_nodes',
  'backlinks',
  'create_node',
  'create_nodes_from_tree',
  'paste_nodes_into_node',
  'split_node',
  'update_node_text',
  'update_node_description',
  'set_node_toolbar_visible',
  'set_node_sort',
  'set_node_filter',
  'set_node_group',
  'merge_node_into',
  'move_node',
  'indent_node',
  'outdent_node',
  'trash_node',
  'batch_trash_nodes',
  'batch_indent_nodes',
  'batch_outdent_nodes',
  'batch_toggle_done',
  'batch_duplicate_nodes',
  'batch_move_nodes_up',
  'batch_move_nodes_down',
  'batch_apply_tag',
  'restore_node',
  'delete_node',
  'toggle_done',
  'create_tag',
  'apply_tag',
  'remove_tag',
  'set_tag_config',
  'set_field_config',
  'create_field_def',
  'create_inline_field_after_node',
  'create_inline_field',
  'register_collected_option',
  'select_field_option',
  'add_reference',
  'replace_node_with_reference',
  'ensure_date_node',
  'ensure_tag_search',
  'undo',
  'redo',
] as const;

export const AGENT_COMMANDS = [
  'agent_restore_latest_session',
  'agent_restore_session',
  'agent_create_session',
  'agent_list_sessions',
  'agent_rename_session',
  'agent_delete_session',
  'agent_debug_snapshot',
  'agent_debug_history',
  'agent_debug_totals',
  'agent_send_message',
  'agent_edit_message',
  'agent_regenerate_message',
  'agent_retry_message',
  'agent_switch_branch',
  'agent_queue_follow_up',
  'agent_clear_follow_up',
  'agent_stop_session',
  'agent_reset_session',
  'agent_close_session',
  'agent_get_provider_settings',
  'agent_upsert_provider_config',
  'agent_delete_provider_config',
  'agent_set_active_provider',
  'agent_set_provider_api_key',
  'agent_delete_provider_api_key',
  'agent_get_provider_secret_status',
] as const;

export type DocumentCommand = typeof DOCUMENT_COMMANDS[number];
export type AgentCommand = typeof AGENT_COMMANDS[number];
export type LinCommand = DocumentCommand | AgentCommand;

const documentCommands = new Set<string>(DOCUMENT_COMMANDS);
const agentCommands = new Set<string>(AGENT_COMMANDS);

export function isDocumentCommand(command: string): command is DocumentCommand {
  return documentCommands.has(command);
}

export function isAgentCommand(command: string): command is AgentCommand {
  return agentCommands.has(command);
}
