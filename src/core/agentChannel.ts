import {
  getAgentEventRuntimeTranscriptPath,
  isAgentConversationMessage,
  type AgentEventMessageRecord,
  type AgentEventReplayState,
  type AgentPrincipal,
  type AgentRunRecord,
} from './agentEventLog';
import { escapeXml } from './reminderXml';

/**
 * Pure multi-agent Channel logic ([[agent-conversation-model]], ratified):
 * mention resolution over the member roster, message ownership, and the §8
 * POV flatten ([[agent-data-model]]) that derives one agent's view of the
 * shared thread. The runtime (main process) and the renderer both consume the
 * mention-token derivation, so it must stay deterministic from the agentId
 * alone — no registry lookups here.
 */

export const DEFAULT_GENERAL_CHANNEL_ID = 'lin-agent-channel-general';
export const DEFAULT_GENERAL_CHANNEL_TITLE = 'General';

/** A conversation routes between agents iff more than one agent is a member. */
export function isMultiAgentConversation(members: readonly AgentPrincipal[]): boolean {
  return channelAgentMembers(members).length >= 2;
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

function mentionPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // No lookbehind on the leading edge: "email@bob" should not mention bob, so
  // require start-of-string or a non-word character before the `@`.
  return new RegExp(`(?:^|[^a-zA-Z0-9._-])@${escaped}(?![a-zA-Z0-9._-])`, 'i');
}

/**
 * Resolve `@` mentions in `text` against the conversation's agent members
 * (Slack-style: the candidate set is the roster, nothing else). Returns matched
 * members ordered by first mention position, deduplicated.
 */
export function parseAgentMentionTargets(
  text: string,
  members: readonly AgentPrincipal[],
  options: { excludeAgentId?: string } = {},
): Extract<AgentPrincipal, { type: 'agent' }>[] {
  const candidates = channelAgentMembers(members)
    .filter((member) => member.agentId !== options.excludeAgentId);
  const hits: Array<{ index: number; member: Extract<AgentPrincipal, { type: 'agent' }> }> = [];
  for (const member of candidates) {
    const match = mentionPattern(agentMentionToken(member.agentId)).exec(text);
    if (match) hits.push({ index: match.index, member });
  }
  return hits
    .sort((left, right) => left.index - right.index)
    .map((hit) => hit.member);
}

/**
 * Hand-off targets named by an agent reply: every `@member` mention that is not
 * the speaker. Hand-off uses the same addressing rule as a user message
 * (PM-ratified 2026-06-10): all addressees run, each addressed BY this reply —
 * so their contexts cut at it (independence rule), and the chain is unbounded
 * (user `stop` is the circuit breaker).
 */
export function handOffTargets(
  text: string,
  members: readonly AgentPrincipal[],
  speakerAgentId: string,
): Extract<AgentPrincipal, { type: 'agent' }>[] {
  return parseAgentMentionTargets(text, members, { excludeAgentId: speakerAgentId });
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
 * Independence cut (PM-ratified 2026-06-10): an addressed run's context is the
 * transcript path up to and including the message that addressed it, plus the
 * POV agent's OWN records after that point (its in-flight turn). Same-round
 * co-addressees are therefore mutually invisible; a hand-off target — addressed
 * by the handing-off reply — sees that reply and everything before it.
 *
 * If the addressing message is no longer on the path (e.g. compaction rewrote
 * history mid-round), the cut fails open to the full path: a stale boundary
 * must never silently truncate real history.
 */
export function cutChannelPathForRun(
  path: readonly AgentEventMessageRecord[],
  runs: Record<string, AgentRunRecord>,
  povAgentId: string,
  addressedByMessageId: string | null,
  mainAgentId: string,
): AgentEventMessageRecord[] {
  if (!addressedByMessageId) return [...path];
  const cutIndex = path.findIndex((record) => record.id === addressedByMessageId);
  if (cutIndex === -1) return [...path];
  const result = path.slice(0, cutIndex + 1);
  for (const record of path.slice(cutIndex + 1)) {
    const owner = channelMessageOwner(record, runs, mainAgentId);
    if (owner.type === 'agent' && owner.agentId === povAgentId) result.push(record);
  }
  return result;
}

/** One source turn inside a coalesced user-role block of the POV flatten. */
export interface PovFlattenedPart {
  /** Identity preamble for the source turn; null for system substrate (already self-describing). */
  preamble: string | null;
  record: AgentEventMessageRecord;
}

export type PovFlattenStep =
  | { kind: 'verbatim'; record: AgentEventMessageRecord }
  | { kind: 'flattened'; parts: PovFlattenedPart[] };

export interface PovFlattenOptions {
  mainAgentId: string;
  /** Optional display names (agentId → name) to enrich identity preambles. */
  displayNameByAgentId?: Record<string, string>;
}

export interface AgentPovProjectionOptions extends PovFlattenOptions {
  /**
   * Optional explicit Channel addressing boundary. Runtime active turns pass
   * their in-memory run boundary; inspector projections fall back to the latest
   * run boundary recorded in replay state for the selected agent.
   */
  addressedByMessageId?: string | null;
}

export interface AgentPovProjection {
  agentId: string;
  addressedByMessageId: string | null;
  steps: PovFlattenStep[];
}

/**
 * The one §8 POV derivation consumed by both runtime assembly and the read-only
 * inspector. It owns the Channel independence cut and flatten selection; callers
 * may render the returned steps to provider messages, UI rows, or tests, but
 * must not reimplement the mapping.
 */
export function deriveAgentPovProjection(
  state: AgentEventReplayState,
  agentId: string,
  options: AgentPovProjectionOptions,
): AgentPovProjection {
  const addressedByMessageId = Object.hasOwn(options, 'addressedByMessageId')
    ? options.addressedByMessageId ?? null
    : latestAddressingMessageIdForAgent(state.runs, agentId);
  const path = cutChannelPathForRun(
    getAgentEventRuntimeTranscriptPath(state),
    state.runs,
    agentId,
    addressedByMessageId,
    options.mainAgentId,
  );
  return {
    agentId,
    addressedByMessageId,
    steps: flattenAgentPathForPov(path, state.runs, agentId, options),
  };
}

/**
 * §8 POV flatten ([[agent-data-model]]): derive agent `povAgentId`'s view of the
 * shared transcript. The POV agent's own turns (assistant + its tool results)
 * pass through verbatim, preserving toolCall/toolResult pairing; everyone else —
 * the user and other agents — coalesces into user-role blocks, one identity
 * preamble per source turn, so consecutive foreign turns never break the
 * provider's role alternation. Other agents contribute only their
 * conversation-visible replies (their execution detail — tool calls/results —
 * is theirs alone and is dropped).
 */
export function flattenAgentPathForPov(
  path: readonly AgentEventMessageRecord[],
  runs: Record<string, AgentRunRecord>,
  povAgentId: string,
  options: PovFlattenOptions,
): PovFlattenStep[] {
  const steps: PovFlattenStep[] = [];
  let pending: PovFlattenedPart[] = [];

  const flush = () => {
    if (pending.length > 0) {
      steps.push({ kind: 'flattened', parts: pending });
      pending = [];
    }
  };

  for (const record of path) {
    const owner = channelMessageOwner(record, runs, options.mainAgentId);
    if (owner.type === 'agent' && owner.agentId === povAgentId) {
      flush();
      steps.push({ kind: 'verbatim', record });
      continue;
    }
    if (record.role === 'user') {
      pending.push({
        preamble: owner.type === 'user' ? povIdentityPreamble(owner, options) : null,
        record,
      });
      continue;
    }
    if (record.role === 'assistant') {
      // Another agent's turn: only its conversation-visible reply crosses POVs.
      if (!isAgentConversationMessage(record)) continue;
      if (!recordHasVisibleText(record)) continue;
      pending.push({ preamble: povIdentityPreamble(owner, options), record });
      continue;
    }
    // Another agent's tool result: execution detail, never shared.
  }
  flush();
  return steps;
}

/**
 * The `@mention` + optional display-name label for an agent member, shared by the
 * POV identity preamble and the environment reminder's roster so the two never
 * drift. The display name is shown only when it differs from the mention token
 * (case-insensitive) and is `escapeXml`-escaped — both consumers render it inside
 * a pseudo-XML reminder block where a raw `<`/`&` in a user-authored name could
 * break the tag boundary. The caller supplies the surrounding format.
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

/**
 * The identity preamble for a flattened source turn, rendered by the runtime
 * inside a `<system-reminder>` wrapper.
 */
export function povIdentityPreamble(
  owner: ChannelMessageOwner,
  options: PovFlattenOptions,
): string {
  if (owner.type === 'user') return '@user (the human user) said:';
  if (owner.type === 'agent') {
    const { mention, displayName } = agentMemberMentionLabel(owner.agentId, options.displayNameByAgentId);
    return displayName
      ? `@${mention} (agent "${displayName}") said:`
      : `@${mention} (agent) said:`;
  }
  return '';
}

function recordHasVisibleText(record: AgentEventMessageRecord): boolean {
  return record.content.some((part) => part.type === 'text' && part.text.trim().length > 0);
}

function latestAddressingMessageIdForAgent(
  runs: Record<string, AgentRunRecord>,
  agentId: string,
): string | null {
  let latest: AgentRunRecord | null = null;
  for (const run of Object.values(runs)) {
    if (run.agentId !== agentId || !run.addressedByMessageId) continue;
    if (!latest || run.startedAt > latest.startedAt || (run.startedAt === latest.startedAt && run.id > latest.id)) {
      latest = run;
    }
  }
  return latest?.addressedByMessageId ?? null;
}
