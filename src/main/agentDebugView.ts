import type {
  AgentDebugConversation,
  AgentDebugConversationShape,
  AgentDebugMessagePart,
  AgentDebugMessageRow,
  AgentDebugRound,
  AgentDebugRun,
  AgentDebugRunSummary,
  AgentDebugToolEntry,
  AgentDebugToolExchange,
  AgentDebugTotals,
  AgentDebugTurnStatus,
  AgentDebugUsage,
  Usage,
} from '../core/agentTypes';
import type { AgentEvent, AgentPersistedContent } from '../core/agentEventLog';
import type { AgentRunMetaProjection } from './agentEventStore';

// Run-grounded debug derivation ([[agent-debug-run-grounded]]): pure transforms
// from a run's own event stream + meta into the execution-tree view. The unit is
// the ROUND — one provider call, bounded by `assistant_message.started`. No
// provider-wire parsing, no seq-matching across streams: a run replays alone and
// its rounds fall out of the ledger it already wrote.

/** A per-run snapshot of the agent's system prompt + tools, captured once per run. */
export interface AgentDebugRunSnapshot {
  systemPrompt: string | null;
  tools: AgentDebugToolEntry[];
}

interface DerivedRunContext {
  meta: AgentRunMetaProjection;
  snapshot?: AgentDebugRunSnapshot | null;
  /**
   * The parent tool call this run answers, read from the PARENT stream's
   * `child_run.started`. It is never in the child's own ledger, so the caller
   * (which holds both streams) supplies it; null for top-level runs.
   */
  parentToolCallId?: string | null;
}

export function deriveDebugRounds(events: readonly AgentEvent[]): AgentDebugRound[] {
  const rounds: AgentDebugRound[] = [];
  let pendingWindow: AgentDebugMessageRow[] = [];
  let current: AgentDebugRound | null = null;
  // Rounds begin only after the run's OWN `run.started`. A child run's ledger
  // opens with the fork prefix (the inherited transcript), whose assistant
  // messages emit `assistant_message.started` BEFORE `run.started` — those are
  // context, not provider rounds, so we fold them into the first round's window.
  let sawRunStart = false;

  for (const event of events) {
    switch (event.type) {
      case 'run.started': {
        sawRunStart = true;
        break;
      }
      case 'user_message.created': {
        // New context entering the next round (the triggering / follow-up message).
        pendingWindow.push(messageRow(event.messageId, 'user', persistedParts(event.content)));
        break;
      }
      case 'tool_result.created': {
        const result = persistedText(event.content) || event.outputSummary || '';
        recordToolResult(rounds, current, event.toolCallId, event.toolName, result, event.isError === true);
        // The same result is the next round's visible context.
        pendingWindow.push(toolResultRow(event.messageId, event.toolCallId, event.toolName, result, event.isError === true));
        break;
      }
      case 'tool_result.replaced': {
        // Output slimming: what the model actually saw on its next turn. Patch the
        // exchange wherever it lives — by now `current` may be a later round. Keep
        // the original isError (a replacement doesn't restate success/failure).
        const result = persistedText(event.content) || event.outputSummary || '';
        recordToolResult(rounds, current, event.toolCallId, undefined, result, undefined);
        break;
      }
      case 'assistant_message.started': {
        // Fork-prefix assistant messages precede run.started; skip them as rounds.
        if (!sawRunStart) break;
        current = {
          index: rounds.length,
          messageId: event.messageId,
          provider: event.providerId,
          modelId: event.modelId,
          api: typeof event.apiId === 'string' ? event.apiId : null,
          status: 'running',
          requestWindow: pendingWindow,
          responseParts: [],
          stopReason: null,
          usage: null,
          toolExchanges: [],
          transport: null,
          wire: null,
          startedAt: event.createdAt,
          completedAt: null,
        };
        pendingWindow = [];
        rounds.push(current);
        break;
      }
      case 'assistant_message.completed': {
        if (!sawRunStart) {
          // Fork-prefix assistant message: inherited context for the first round.
          pendingWindow.push(messageRow(event.messageId, 'assistant', persistedParts(event.content)));
          break;
        }
        if (current && current.messageId === event.messageId) {
          current.responseParts = persistedParts(event.content);
          current.stopReason = event.stopReason ?? null;
          current.status = statusFromStopReason(event.stopReason);
          current.usage = usageToDebugUsage(event.usage);
          current.completedAt = event.createdAt;
          // Seed tool exchanges from the assistant's own tool-call content so a
          // round shows its calls even before (or without) results.
          for (const part of current.responseParts) {
            if (part.kind === 'toolCall' && !current.toolExchanges.some((entry) => entry.toolCallId === part.toolUseId)) {
              current.toolExchanges.push({
                toolCallId: part.toolUseId,
                toolName: part.name,
                args: part.body,
                result: null,
                isError: false,
              });
            }
          }
        }
        break;
      }
      case 'assistant_message.failed': {
        if (current && current.messageId === event.messageId) {
          current.status = 'error';
          current.completedAt = event.createdAt;
        }
        break;
      }
      default:
        break;
    }
  }

  return rounds;
}

export function deriveDebugRun(events: readonly AgentEvent[], context: DerivedRunContext): AgentDebugRun {
  const { meta } = context;
  const rounds = deriveDebugRounds(events);
  const lastRound = rounds.at(-1);
  return {
    runId: meta.id,
    agentId: meta.agentId,
    kind: meta.kind,
    status: runStatus(meta.status),
    parentRunId: meta.parentRunId ?? null,
    parentToolCallId: context.parentToolCallId ?? null,
    addressedByMessageId: addressedByMessageId(events),
    triggerMessageId: triggerMessageId(meta),
    provider: lastRound?.provider ?? null,
    modelId: lastRound?.modelId ?? null,
    usage: usageToDebugUsage(meta.usage),
    createdAt: meta.createdAt,
    systemPrompt: context.snapshot?.systemPrompt ?? null,
    tools: context.snapshot?.tools ?? [],
    rounds,
  };
}

/**
 * Project a fully-derived run into its tree node. A pure projection — every field
 * is copied from the run, so the summary can never disagree with the detail (this
 * is why the anchors are sourced once, in {@link deriveDebugRun}, not twice).
 */
export function summarizeDebugRun(run: AgentDebugRun): AgentDebugRunSummary {
  return {
    runId: run.runId,
    agentId: run.agentId,
    kind: run.kind,
    status: run.status,
    parentRunId: run.parentRunId,
    parentToolCallId: run.parentToolCallId,
    addressedByMessageId: run.addressedByMessageId,
    triggerMessageId: run.triggerMessageId,
    provider: run.provider,
    modelId: run.modelId,
    usage: run.usage,
    createdAt: run.createdAt,
    roundCount: run.rounds.length,
  };
}

export function deriveDebugConversation(
  conversationId: string,
  shape: AgentDebugConversationShape,
  members: string[],
  runs: AgentDebugRunSummary[],
): AgentDebugConversation {
  const totals = emptyDebugTotals();
  for (const run of runs) {
    totals.rounds += run.roundCount;
    if (run.usage) addUsage(totals, run.usage);
  }
  totals.queries = runs.filter((run) => run.kind === 'turn').length;
  return { conversationId, shape, members, runs, totals };
}

// --- helpers ---------------------------------------------------------------

function persistedParts(content: readonly AgentPersistedContent[]): AgentDebugMessagePart[] {
  return content.map((part): AgentDebugMessagePart => {
    if (part.type === 'text') return { kind: 'text', body: part.text, isReminder: part.text.startsWith('<system-reminder>') };
    if (part.type === 'thinking') return { kind: 'thinking', body: part.redacted ? '[redacted thinking]' : part.thinking };
    // Tool-call arguments can carry credentials (api_key, authorization, …); the
    // debug view is read-only but still on screen, so redact before rendering.
    if (part.type === 'toolCall') return { kind: 'toolCall', name: part.name, toolUseId: part.id, body: sanitizedJson(part.arguments) };
    if (part.type === 'image') return { kind: 'image', body: part.alt ?? '[image]' };
    if (part.type === 'payload_ref') return { kind: 'json', body: part.label ?? `[payload ${part.payload.id}]` };
    return { kind: 'json', body: sanitizedJson(part) };
  });
}

function persistedText(content: readonly AgentPersistedContent[]): string {
  return content
    .map((part) => (part.type === 'text' ? part.text : part.type === 'thinking' ? part.thinking : ''))
    .filter(Boolean)
    .join('\n');
}

function messageRow(id: string, role: string, parts: AgentDebugMessagePart[]): AgentDebugMessageRow {
  const json = stableJson(parts);
  return { id, role, summary: summarize(role, parts), json, bytes: byteLength(json), parts };
}

function toolResultRow(messageId: string, toolCallId: string, toolName: string, body: string, isError: boolean): AgentDebugMessageRow {
  // toolUseId must be the tool CALL id (so the result links to its call), not the
  // result message id — those are distinct ids on a tool_result event.
  const parts: AgentDebugMessagePart[] = [{ kind: 'toolResult', toolUseId: toolCallId, body, isError }];
  return { id: messageId, role: 'tool', summary: `tool: ${toolName}`, json: stableJson(parts), bytes: byteLength(body), parts };
}

/**
 * Attach a tool result to its exchange. A `tool_result.created` lands on the
 * round still in flight; a `tool_result.replaced` (output slimming) can arrive
 * after the next round opened, so we search every round, newest first. `isError`
 * is left untouched when undefined (replacements don't restate it).
 */
function recordToolResult(
  rounds: readonly AgentDebugRound[],
  current: AgentDebugRound | null,
  toolCallId: string,
  toolName: string | undefined,
  result: string,
  isError: boolean | undefined,
): void {
  const search = current ? [current, ...rounds.filter((round) => round !== current)] : rounds;
  for (const round of search) {
    const exchange = round.toolExchanges.find((entry) => entry.toolCallId === toolCallId);
    if (exchange) {
      exchange.result = result;
      if (isError !== undefined) exchange.isError = isError;
      return;
    }
  }
  // No seeded exchange (result before the round's .completed): open one on the
  // round in flight. A replacement with no live round has nowhere to land.
  if (current) {
    current.toolExchanges.push({ toolCallId, toolName: toolName ?? '', args: '', result, isError: isError === true });
  }
}

function usageToDebugUsage(usage: Usage | undefined): AgentDebugUsage | null {
  if (!usage) return null;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    costUsd: usage.cost?.total ?? 0,
    costInputUsd: usage.cost?.input ?? 0,
    costOutputUsd: usage.cost?.output ?? 0,
    costCacheReadUsd: usage.cost?.cacheRead ?? 0,
    costCacheWriteUsd: usage.cost?.cacheWrite ?? 0,
  };
}

function emptyDebugTotals(): AgentDebugTotals {
  return {
    queries: 0, rounds: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    totalTokens: 0, costUsd: 0, costInputUsd: 0, costOutputUsd: 0, costCacheReadUsd: 0, costCacheWriteUsd: 0,
  };
}

function addUsage(totals: AgentDebugTotals, usage: AgentDebugUsage) {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.totalTokens += usage.totalTokens;
  totals.costUsd += usage.costUsd;
  totals.costInputUsd += usage.costInputUsd;
  totals.costOutputUsd += usage.costOutputUsd;
  totals.costCacheReadUsd += usage.costCacheReadUsd;
  totals.costCacheWriteUsd += usage.costCacheWriteUsd;
}

function statusFromStopReason(stopReason: unknown): AgentDebugTurnStatus {
  if (stopReason === 'aborted') return 'aborted';
  if (stopReason === 'error') return 'error';
  return 'completed';
}

function runStatus(status: string): AgentDebugTurnStatus {
  if (status === 'running') return 'running';
  if (status === 'failed') return 'error';
  if (status === 'cancelled') return 'aborted';
  return 'completed';
}

function triggerMessageId(meta: AgentRunMetaProjection): string | null {
  return meta.trigger.type === 'message' ? meta.trigger.messageId : null;
}

function addressedByMessageId(events: readonly AgentEvent[]): string | null {
  for (const event of events) {
    if (event.type === 'run.started' && typeof event.addressedByMessageId === 'string') return event.addressedByMessageId;
  }
  return null;
}

function summarize(role: string, parts: AgentDebugMessagePart[]): string {
  const text = parts.find((part) => part.kind === 'text' && !part.isReminder);
  if (text?.kind === 'text') return `${role}: ${truncate(text.body, 72)}`;
  const calls = parts.filter((part) => part.kind === 'toolCall').length;
  const results = parts.filter((part) => part.kind === 'toolResult').length;
  const labels = [
    calls ? `${calls} tool call${calls === 1 ? '' : 's'}` : '',
    results ? `${results} tool result${results === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return labels.length ? `${role}: ${labels.join(', ')}` : role;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Keys whose values are credentials — redacted before anything reaches the
// (read-only but on-screen) debug view. Mirrors the old agentDebug sanitizer.
const SECRET_KEY_PATTERN = /api[_-]?key|authorization|bearer|secret|password|token/i;

/** Pretty-print a value with secret-bearing keys redacted, recursively. */
function sanitizedJson(value: unknown): string {
  return stableJson(redactSecrets(value));
}

function redactSecrets(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactSecrets(item);
  }
  return output;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}
