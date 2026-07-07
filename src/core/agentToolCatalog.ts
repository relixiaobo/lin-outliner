// Common optional tools exposed as toggles in the agent authoring UI. Names are
// canonical lowercase forms matched by agentTools.ts:filterAgentTools.
export const TOOL_CATALOG = [
  'file_read', 'file_glob', 'file_grep', 'file_edit', 'file_write',
  'bash', 'web_search', 'web_fetch',
  'generate_image',
  'issue_search', 'issue_read', 'issue_create', 'issue_update',
  'agent_session_start', 'agent_session_read', 'agent_session_send_message', 'agent_session_stop',
] as const;
