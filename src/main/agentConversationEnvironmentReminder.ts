import type { AgentPrincipal } from '../core/agentEventLog';
import { agentMentionToken, channelAgentMembers, isMultiAgentConversation } from '../core/agentChannel';
import { escapeXml, xmlAttrs } from './agentReminderXml';

/**
 * The Channel/DM **environment** reminder ([[agent-conversation-model]] reminder
 * stack — the `environment` slot). DM-vs-Channel framing, the member roster, and
 * the Channel communication norms are dynamic environment, NOT identity, so they
 * ride the per-turn `<system-reminder>` stack — never the stable system prompt
 * (which stays identity-only and cacheable across DM and Channel).
 *
 * POV-specific: the reminder is written for `povAgentId` (the in-flight run's
 * executing member), so it must be assembled per run, not on the shared
 * user-turn reminder stack.
 */
export interface ConversationEnvironmentReminderInput {
  members: readonly AgentPrincipal[];
  /** The in-flight run's executing member — the reminder is written for it. */
  povAgentId: string;
  /** The Channel's display name (legacy `goal` field); null for a DM. */
  channelName?: string | null;
  /** Display names (agentId → name) to enrich the member roster. */
  displayNames?: Record<string, string>;
}

export function buildConversationEnvironmentReminder(
  input: ConversationEnvironmentReminderInput,
): string | null {
  return isMultiAgentConversation(input.members)
    ? renderChannelEnvironment(input)
    : renderDirectMessageEnvironment();
}

function renderChannelEnvironment(input: ConversationEnvironmentReminderInput): string {
  const roster = channelAgentMembers(input.members)
    .map((member) => {
      // The mention token is already normalized to [a-z0-9._-] at id construction,
      // so it needs no escaping; the user-authored display name does (it lands in
      // the reminder's prose body, not an attribute, so xmlAttrs never sees it).
      const token = agentMentionToken(member.agentId);
      const name = input.displayNames?.[member.agentId];
      const labelled = name && name.toLowerCase() !== token.toLowerCase()
        ? `@${token} ("${escapeXml(name)}")`
        : `@${token}`;
      return member.agentId === input.povAgentId ? `${labelled} (you)` : labelled;
    });
  const members = [...roster, 'the user'].join(', ');
  return [
    `<conversation-environment${xmlAttrs({ kind: 'channel', name: input.channelName ?? null })}>`,
    `Members: ${members}.`,
    '- Speak as yourself; your reply is posted to the shared thread under your name.',
    "- Other members' turns appear as quoted context with an identity preamble; never imitate another member or speak on their behalf.",
    '- To hand off to another member, mention them as @<name> — only when they are clearly better suited. Mentions route turns with no relay limit, so mention deliberately and avoid mention loops; the user can stop the round at any time.',
    '- Only your final message is shared with the other members; your intermediate thinking and tool steps stay private. Lead with the result and keep your final reply self-contained.',
    '- Stay within your description and instructions; defer outside work to better-suited members.',
    '</conversation-environment>',
  ].join('\n');
}

function renderDirectMessageEnvironment(): string {
  return [
    '<conversation-environment kind="dm">',
    'You are in a direct 1:1 conversation with the user. There are no other agent members here; do not hand off or mention another agent as a routing instruction. If the user needs a broader room, suggest creating a Channel.',
    '</conversation-environment>',
  ].join('\n');
}
