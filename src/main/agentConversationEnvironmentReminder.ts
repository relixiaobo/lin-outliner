/**
 * The conversation **environment** reminder ([[agent-conversation-model]]
 * reminder stack — the `environment` slot). The 1:1 framing is dynamic
 * environment, NOT identity, so it rides the per-turn `<system-reminder>` stack
 * rather than the stable, cacheable system prompt (which stays identity-only).
 *
 * Single-agent: there is exactly one agent and every conversation is a direct
 * 1:1 with the user, so this is a single fixed block (no roster, no POV).
 */
export function buildConversationEnvironmentReminder(): string {
  return [
    '<conversation-environment kind="dm">',
    'You are in a direct 1:1 conversation with the user.',
    '- Speak as yourself; your reply is posted to this conversation under your name.',
    '- Stay within your description and instructions.',
    '</conversation-environment>',
  ].join('\n');
}
