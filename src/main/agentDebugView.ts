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
import type { AgentEvent, AgentPersistedContent, DebugRunToolSchema } from '../core/agentEventLog';
import type { AgentRunMetaProjection } from './agentEventStore';
import { redactSecretLikeContent } from './agentSecretRedaction';

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
          status: 'running',
          requestWindow: pendingWindow,
          responseParts: [],
          stopReason: null,
          usage: null,
          toolExchanges: [],
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
    provider: lastRound?.provider ?? null,
    modelId: lastRound?.modelId ?? null,
    // `meta.usage` is only written when a run terminates; while it streams, roll
    // up the rounds' own usage so the summary/totals stay live (and never lag the
    // per-round detail the user can already see).
    usage: usageToDebugUsage(meta.usage) ?? aggregateRoundUsage(rounds),
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

/**
 * The once-per-run request context the ledger lacks: the agent's outbound system
 * prompt + tool schemas, pulled from the raw provider payload at capture time
 * ([[agent-debug-run-grounded]]). The message window is already event-sourced, so
 * we keep only system + tools. Tolerant of both provider shapes: Anthropic puts
 * the system prompt at the top level (`system`), while the OpenAI providers
 * (responses / completions) fold it into the message array as a `system` /
 * `developer` role entry — so we fall back to scanning `input` / `messages`.
 */
export function extractRunSnapshotFromPayload(payload: unknown): { systemPrompt: string; tools: DebugRunToolSchema[] } {
  if (!isRecord(payload)) return { systemPrompt: '', tools: [] };
  const systemPrompt = firstNonEmpty([
    extractSystemPrompt(payload.system),
    extractSystemPrompt(payload.instructions),
    extractSystemPrompt(payload.systemPrompt),
    extractSystemFromMessages(payload.input),
    extractSystemFromMessages(payload.messages),
  ]);
  return { systemPrompt, tools: extractTools(payload.tools) };
}

/** OpenAI-style fold: the system prompt is a `system`/`developer` role message. */
function extractSystemFromMessages(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (!isRecord(item) || (item.role !== 'system' && item.role !== 'developer')) return '';
      return extractSystemPrompt(item.content);
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The run's per-run system/tools snapshot, read from the latest
 * `debug.run_snapshot.created` in its stream (hash-deduped at capture, so the
 * last one is current). Null when no snapshot was captured (e.g. a delegation
 * run, whose request-context capture is a follow-up) — the view degrades to no
 * system prompt and an empty tool list.
 */
export function snapshotFromRunEvents(events: readonly AgentEvent[]): AgentDebugRunSnapshot | null {
  let latest: Extract<AgentEvent, { type: 'debug.run_snapshot.created' }> | null = null;
  for (const event of events) {
    if (event.type === 'debug.run_snapshot.created') latest = event;
  }
  if (!latest) return null;
  return {
    systemPrompt: latest.systemPrompt,
    tools: latest.tools.map((tool): AgentDebugToolEntry => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      bytes: byteLength(tool.name) + byteLength(tool.description) + byteLength(tool.schema),
    })),
  };
}

function extractSystemPrompt(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!isRecord(item)) return '';
        if (typeof item.text === 'string') return item.text;
        if (typeof item.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
  }
  return '';
}

function extractTools(value: unknown): DebugRunToolSchema[] {
  if (!Array.isArray(value)) return [];
  return value.map((rawTool, index): DebugRunToolSchema => {
    const tool = isRecord(rawTool) ? rawTool : {};
    const fn = isRecord(tool.function) ? tool.function : {};
    const name = stringValue(tool.name) || stringValue(fn.name) || `tool_${index + 1}`;
    const description = stringValue(tool.description) || stringValue(fn.description) || '';
    const schemaValue = tool.input_schema ?? tool.parameters ?? fn.parameters ?? tool.schema ?? {};
    return { name, description, schema: stableJson(schemaValue) };
  });
}

function firstNonEmpty(values: string[]): string {
  for (const value of values) if (value) return value;
  return '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  return { id, role, summary: summarize(role, parts), bytes: byteLength(stableJson(parts)), parts };
}

function toolResultRow(messageId: string, toolCallId: string, toolName: string, body: string, isError: boolean): AgentDebugMessageRow {
  // toolUseId must be the tool CALL id (so the result links to its call), not the
  // result message id — those are distinct ids on a tool_result event.
  const parts: AgentDebugMessagePart[] = [{ kind: 'toolResult', toolUseId: toolCallId, body, isError }];
  // bytes measure the serialized parts (same basis as messageRow), so a tool row's
  // context cost is comparable with every other request-window row.
  return { id: messageId, role: 'tool', summary: `tool: ${toolName}`, bytes: byteLength(stableJson(parts)), parts };
}

/**
 * Attach a tool result to its exchange. A `tool_result.created` lands on the
 * round still in flight; a `tool_result.replaced` (output slimming, stamped with
 * its producing run's id) lands on whichever earlier round made the call — so we
 * search the in-flight round first, then the rest. `isError` is left untouched
 * when undefined (replacements don't restate it).
 *
 * Only a `.created` (which carries `toolName`) may OPEN an exchange — a result
 * arriving before its round's `.completed` seeded the call. A `.replaced`
 * (toolName undefined) only patches an existing exchange; if it matches none in
 * this run (it was slimmed during a different run, so its call lives elsewhere),
 * it is dropped rather than fabricating an empty-named phantom exchange.
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
  if (current && toolName !== undefined) {
    current.toolExchanges.push({ toolCallId, toolName, args: '', result, isError: isError === true });
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
  };
}

/** Roll up the rounds' own usage — the live total before `meta.usage` is written. */
function aggregateRoundUsage(rounds: readonly AgentDebugRound[]): AgentDebugUsage | null {
  const withUsage = rounds.filter((round): round is AgentDebugRound & { usage: AgentDebugUsage } => round.usage !== null);
  if (withUsage.length === 0) return null;
  const totals: AgentDebugUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
  for (const round of withUsage) addUsage(totals, round.usage);
  return totals;
}

function emptyDebugTotals(): AgentDebugTotals {
  return { queries: 0, rounds: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
}

function addUsage(totals: AgentDebugUsage, usage: AgentDebugUsage) {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.totalTokens += usage.totalTokens;
  totals.costUsd += usage.costUsd;
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

/**
 * Pretty-print a value with secrets redacted, recursively. Two complementary
 * passes: by key NAME (`api_key: …`), then by VALUE PATTERN over the serialized
 * text ({@link redactSecretLikeContent}) to catch credentials embedded in a
 * free-text field (e.g. a `Bearer sk-…` inside a tool's `command` argument).
 */
function sanitizedJson(value: unknown): string {
  return redactSecretLikeContent(stableJson(redactSecrets(value)));
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

const TEXT_ENCODER = new TextEncoder();

function byteLength(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}
