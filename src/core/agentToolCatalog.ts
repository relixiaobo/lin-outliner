// Common Run-control tools exposed as toggles in the agent authoring UI. Names are
// canonical lowercase forms matched by agentTools.ts:filterAgentTools.
export const TOOL_CATALOG = [
  'file_read', 'file_glob', 'file_grep', 'file_edit', 'file_write',
  'bash', 'web_search', 'web_fetch',
  'spawn_run', 'run_status', 'run_steer', 'run_amend', 'run_stop',
] as const;
