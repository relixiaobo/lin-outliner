export function portableProviderToolCallId(toolCallId: string): string {
  return `tc_${toolCallId.split('-').join('')}`;
}
