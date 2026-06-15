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
}

export function deriveDebugRounds(events: readonly AgentEvent[]): AgentDebugRound[] {
  const rounds: AgentDebugRound[] = [];
  let pendingWindow: AgentDebugMessageRow[] = [];
  let current: AgentDebugRound | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'user_message.created': {
        // New context entering the next round (the triggering / follow-up message).
        pendingWindow.push(messageRow(event.messageId, 'user', persistedParts(event.content)));
        break;
      }
      case 'tool_result.created': {
        const result = persistedText(event.content) || event.outputSummary || '';
        if (current) {
          const exchange = current.toolExchanges.find((entry) => entry.toolCallId === event.toolCallId);
          if (exchange) {
            exchange.result = result;
            exchange.isError = event.isError === true;
          } else {
            current.toolExchanges.push({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: '',
              result,
              isError: event.isError === true,
            });
          }
        }
        // The same result is the next round's visible context.
        pendingWindow.push(toolResultRow(event.messageId, event.toolName, result, event.isError === true));
        break;
      }
      case 'assistant_message.started': {
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
    parentToolCallId: parentToolCallId(events),
    addressedByMessageId: addressedByMessageId(events),
    triggerMessageId: triggerMessageId(meta),
    provider: lastRound?.provider ?? null,
    modelId: lastRound?.modelId ?? null,
    usage: usageToDebugUsage(meta.usage),
    systemPrompt: context.snapshot?.systemPrompt ?? null,
    tools: context.snapshot?.tools ?? [],
    rounds,
  };
}

export function summarizeDebugRun(meta: AgentRunMetaProjection, roundCount: number, lastRound?: AgentDebugRound): AgentDebugRunSummary {
  return {
    runId: meta.id,
    agentId: meta.agentId,
    kind: meta.kind,
    status: runStatus(meta.status),
    parentRunId: meta.parentRunId ?? null,
    parentToolCallId: null,
    addressedByMessageId: null,
    triggerMessageId: triggerMessageId(meta),
    provider: lastRound?.provider ?? null,
    modelId: lastRound?.modelId ?? null,
    usage: usageToDebugUsage(meta.usage),
    roundCount,
    createdAt: meta.createdAt,
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
    if (part.type === 'toolCall') return { kind: 'toolCall', name: part.name, toolUseId: part.id, body: stableJson(part.arguments) };
    if (part.type === 'image') return { kind: 'image', body: part.alt ?? '[image]' };
    return { kind: 'json', body: stableJson(part) };
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

function toolResultRow(id: string, toolName: string, body: string, isError: boolean): AgentDebugMessageRow {
  const parts: AgentDebugMessagePart[] = [{ kind: 'toolResult', toolUseId: id, body, isError }];
  return { id, role: 'tool', summary: `tool: ${toolName}`, json: stableJson(parts), bytes: byteLength(body), parts };
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

function parentToolCallId(events: readonly AgentEvent[]): string | null {
  for (const event of events) {
    if (event.type === 'child_run.started' && typeof event.parentToolCallId === 'string') return event.parentToolCallId;
  }
  return null;
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}
