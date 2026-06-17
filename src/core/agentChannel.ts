import {
  type AgentEventMessageRecord,
  type AgentPrincipal,
  type AgentRunRecord,
} from './agentEventLog';
import { escapeXml } from './reminderXml';

/**
 * Pure Channel logic ([[agent-conversation-model]], ratified): mention resolution
 * over the member roster and message ownership. The runtime (main process) and the
 * renderer both consume the mention-token derivation, so it must stay deterministic
 * from the agentId alone — no registry lookups here.
 */

export const DEFAULT_GENERAL_CHANNEL_ID = 'lin-agent-channel-general';
export const DEFAULT_GENERAL_CHANNEL_TITLE = 'General';

/**
 * Single-agent collapse: a conversation never routes between agents — there is
 * exactly one agent (Neva). Always `false` so the reader-neutral shared-log path
 * and POV inspectors (the multi-agent reminder/independence machinery) are
 * unreachable and get removed wholesale in the teardown slice. Kept as a function
 * for call-site stability; the param is retained for the same reason.
 */
export function isMultiAgentConversation(_members: readonly AgentPrincipal[]): boolean {
  return false;
}

/** Runtime Channel identity is carried by the stable conversation id namespace. */
export function isChannelConversationId(conversationId: string | null | undefined): boolean {
  return conversationId?.startsWith('lin-agent-channel-') ?? false;
}

/**
 * Single-agent collapse: there is no multi-agent Channel work surface anymore.
 * Every conversation has exactly one agent (Neva) and runs as a serial,
 * steerable, inline turn — execution AND rendering. This is the single switch
 * the whole teardown turns on: with it `false`, every `channelSurface` branch in
 * the runtime/projection/renderer takes its single-agent (inline) side, so the
 * now-dead Channel execution + activity-surface code is provably unreachable and
 * gets removed wholesale in the follow-up teardown slice (rather than piecemeal
 * here). Kept as a function — not inlined at call sites — so that removal is one
 * coordinated edit. The params are retained for that call-site stability.
 */
export function usesChannelActivitySurface(
  _conversationId: string | null | undefined,
  _members: readonly AgentPrincipal[],
): boolean {
  return false;
}

export function channelAgentMembers(
  members: readonly AgentPrincipal[],
): Extract<AgentPrincipal, { type: 'agent' }>[] {
  return members.filter((member): member is Extract<AgentPrincipal, { type: 'agent' }> => member.type === 'agent');
}

/**
 * The `@` token for an agent member: the name segment of its stable agentId
 * (`source:namespace:name` — see agentDefinitionAgentId). Already normalized to
 * `[a-z0-9._-]` at id-construction time.
 */
export function agentMentionToken(agentId: string): string {
  const segment = agentId.slice(agentId.lastIndexOf(':') + 1).trim();
  return segment || agentId;
}

export type ChannelMessageOwner = AgentPrincipal | { type: 'system' };

/**
 * Who spoke a transcript record, for POV purposes. User-actor user messages are
 * the human's turns; system-actor user messages are shared substrate (reminders,
 * compaction roots, dream markers). Assistant/tool records belong to the run's
 * executing agent — the run log, not the (tool-typed) actor, is authoritative —
 * falling back to the main agent for pre-Channel history.
 */
export function channelMessageOwner(
  record: AgentEventMessageRecord,
  runs: Record<string, AgentRunRecord>,
  mainAgentId: string,
): ChannelMessageOwner {
  if (record.role === 'user') {
    if (record.actor.type === 'user') return { type: 'user', userId: record.actor.userId };
    return { type: 'system' };
  }
  const runAgentId = record.runId ? runs[record.runId]?.agentId : undefined;
  if (runAgentId) return { type: 'agent', agentId: runAgentId };
  if (record.actor.type === 'agent') return { type: 'agent', agentId: record.actor.agentId };
  return { type: 'agent', agentId: mainAgentId };
}

/**
 * The `@mention` + optional display-name label for an agent member, used by the
 * environment reminder's roster. The display name is shown only when it differs
 * from the mention token (case-insensitive) and is `escapeXml`-escaped — the
 * consumer renders it inside a pseudo-XML reminder block where a raw `<`/`&` in a
 * user-authored name could break the tag boundary. The caller supplies the
 * surrounding format.
 */
export function agentMemberMentionLabel(
  agentId: string,
  displayNames?: Record<string, string>,
): { mention: string; displayName: string | null } {
  const mention = agentMentionToken(agentId);
  const raw = displayNames?.[agentId];
  const displayName = raw && raw.toLowerCase() !== mention.toLowerCase() ? escapeXml(raw) : null;
  return { mention, displayName };
}
