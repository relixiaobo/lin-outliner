export const AGENT_DEBUG_TOOL_RESULT_PREFIX = 'tool_result';
export const AGENT_DEBUG_TOOL_RESULT_PREFIX_PATTERN = /^\[tool_result\s+[^\]]+\]\s*/;

export function formatAgentDebugToolResultText(toolUseId: string | null | undefined, text: string): string {
  const id = typeof toolUseId === 'string' ? toolUseId.trim() : '';
  const body = text.trim();
  return id ? `[${AGENT_DEBUG_TOOL_RESULT_PREFIX} ${id}] ${body}`.trim() : body;
}

export function hasAgentDebugToolResultPrefix(text: string): boolean {
  return AGENT_DEBUG_TOOL_RESULT_PREFIX_PATTERN.test(text);
}

export function stripAgentDebugToolResultPrefix(text: string): string {
  return text.replace(AGENT_DEBUG_TOOL_RESULT_PREFIX_PATTERN, '').trim();
}
