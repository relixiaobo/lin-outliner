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
import { formatAgentDebugToolResultText } from '../core/agentDebugProtocol';
import type { AgentEvent, AgentPersistedContent, DebugRunModelInputMessage, DebugRunToolSchema } from '../core/agentEventLog';
import { deriveAgentRunKind, type AgentRunMetaProjection } from './agentEventStore';
import { elideLargeBlobs, redactSecretKeyedValues, redactSecretLikeContent } from './agentSecretRedaction';

// Run-grounded debug derivation ([[agent-debug-run-grounded]]): pure transforms
// from a run's own event stream + meta into the execution-tree view. The unit is
// the ROUND — one provider call, bounded by `assistant_message.started`. No
// provider-wire parsing, no seq-matching across streams: a run replays alone and
// its rounds fall out of the ledger it already wrote.

/** A derived per-run snapshot of the outbound provider request context. */
export interface AgentDebugRunSnapshot {
  systemPrompt: string | null;
  tools: AgentDebugToolEntry[];
  messages: AgentDebugMessageRow[];
}

interface DerivedRunContext {
  meta: AgentRunMetaProjection;
  snapshot?: AgentDebugRunSnapshot | null;
  /**
   * The parent tool call this run answers, read from Run metadata. It is never
   * in the child's own ledger; null marks top-level runs.
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
        // Tool output can echo file/secret content (`cat .env`, HTTP creds), so
        // redact it before it reaches the exchange and the next round's window.
        const result = redactDisplayText(persistedText(event.content) || event.outputSummary || '');
        recordToolResult(rounds, current, event.toolCallId, event.toolName, result, event.isError === true);
        // The same result is the next round's visible context.
        pendingWindow.push(toolResultRow(event.messageId, event.toolCallId, event.toolName, result, event.isError === true));
        break;
      }
      case 'tool_result.replaced': {
        // Output slimming: what the model actually saw on its next turn. Patch the
        // exchange wherever it lives — by now `current` may be a later round. Keep
        // the original isError (a replacement doesn't restate success/failure).
        const result = redactDisplayText(persistedText(event.content) || event.outputSummary || '');
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
      case 'run.failed':
      case 'run.cancelled': {
        // A run that died mid-stream (crash / force-quit) leaves its last round
        // opened by assistant_message.started with no matching .completed. Close
        // it with the run's terminal status so its pill doesn't read 'running'
        // forever while the run node shows Failed/Aborted.
        if (current && current.status === 'running') {
          current.status = event.type === 'run.cancelled' ? 'aborted' : 'error';
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
  const snapshot = context.snapshot ?? null;
  const capturedModelInputMessages = snapshot?.messages ?? [];
  const hasCapturedModelInput = capturedModelInputMessages.length > 0;
  return {
    runId: meta.id,
    agentId: meta.agentId,
    kind: deriveAgentRunKind(meta),
    status: runStatus(meta.execution.status),
    parentRunId: meta.parentRunId ?? null,
    parentToolCallId: context.parentToolCallId ?? null,
    provider: lastRound?.provider ?? null,
    modelId: lastRound?.modelId ?? null,
    // `meta.usage` is only written when a run terminates; while it streams, roll
    // up the rounds' own usage so the summary/totals stay live (and never lag the
    // per-round detail the user can already see).
    usage: usageToDebugUsage(meta.execution.usage) ?? aggregateRoundUsage(rounds),
    createdAt: meta.createdAt,
    systemPrompt: snapshot?.systemPrompt ?? null,
    tools: snapshot?.tools ?? [],
    modelInputMessages: hasCapturedModelInput ? capturedModelInputMessages : (rounds[0]?.requestWindow ?? []),
    modelInputMessagesSource: hasCapturedModelInput ? 'captured' : 'legacyRequestWindow',
    rounds,
  };
}

/**
 * Project a fully-derived run into its tree node. A pure projection — every field
 * is copied from the run, so the summary can never disagree with the detail (this
 * is why the anchors are sourced once, in {@link deriveDebugRun}, not twice). This
 * is also the reference the light {@link summarizeRunStream} is tested against: a
 * correct-by-construction oracle for the path that skips building the full detail.
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

/**
 * The summary node WITHOUT building the full detail: a single light pass over the
 * run's stream for round count + last provider/model + usage. The conversation
 * tree shows one collapsed node per run, so it never needs the per-round request
 * windows / redaction that {@link deriveDebugRun} materializes ([[agent-debug-run-grounded]]).
 * Round counting mirrors deriveDebugRounds (only after the run's own run.started),
 * so the summary can never disagree with the detail — an equivalence test pins
 * this output to {@link summarizeDebugRun} of the fully-derived run.
 */
export function summarizeRunStream(
  events: readonly AgentEvent[],
  meta: AgentRunMetaProjection,
  parentToolCallId: string | null,
): AgentDebugRunSummary {
  let sawRunStart = false;
  let roundCount = 0;
  let provider: string | null = null;
  let modelId: string | null = null;
  const roundUsages: AgentDebugUsage[] = [];
  for (const event of events) {
    if (event.type === 'run.started') { sawRunStart = true; continue; }
    if (!sawRunStart) continue;
    if (event.type === 'assistant_message.started') {
      roundCount += 1;
      provider = event.providerId;
      modelId = event.modelId;
    } else if (event.type === 'assistant_message.completed') {
      const usage = usageToDebugUsage(event.usage);
      if (usage) roundUsages.push(usage);
    }
  }
  return {
    runId: meta.id,
    agentId: meta.agentId,
    kind: deriveAgentRunKind(meta),
    status: runStatus(meta.execution.status),
    parentRunId: meta.parentRunId ?? null,
    parentToolCallId,
    provider,
    modelId,
    usage: usageToDebugUsage(meta.execution.usage) ?? sumUsages(roundUsages),
    createdAt: meta.createdAt,
    roundCount,
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
 * The once-per-run request context the ledger lacks: the outbound system prompt,
 * tool schemas, and full provider message window, pulled from the raw provider
 * payload at capture time ([[agent-debug-run-grounded]]). Tolerant of both
 * provider shapes: Anthropic puts the system prompt at the top level (`system`),
 * while the OpenAI providers (responses / completions) fold it into the message
 * array as a `system` / `developer` role entry — so we fall back to scanning
 * `input` / `messages`.
 */
export function extractRunSnapshotFromPayload(payload: unknown): { systemPrompt: string; tools: DebugRunToolSchema[]; messages: DebugRunModelInputMessage[] } {
  if (!isRecord(payload)) return { systemPrompt: '', tools: [], messages: [] };
  const systemPrompt = firstNonEmpty([
    extractSystemPrompt(payload.system),
    extractSystemPrompt(payload.instructions),
    extractSystemPrompt(payload.systemPrompt),
    extractSystemFromMessages(payload.input),
    extractSystemFromMessages(payload.messages),
  ]);
  return {
    systemPrompt,
    tools: extractTools(payload.tools),
    messages: firstNonEmptyMessages([extractModelInputMessages(payload.input), extractModelInputMessages(payload.messages)]),
  };
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
 * The run's provider-request snapshot. System/tool metadata comes from the
 * latest `debug.run_snapshot.created` in its stream (hash-deduped at capture, so
 * the last one is current), while Model Input uses the first captured non-empty
 * message window so later tool-result provider calls do not overwrite the run's
 * entry context. Null when no snapshot was captured (e.g. a delegation run,
 * whose request-context capture is a follow-up) — the view degrades to no system
 * prompt, an empty tool list, and the legacy request-window fallback.
 */
export function snapshotFromRunEvents(events: readonly AgentEvent[]): AgentDebugRunSnapshot | null {
  let latest: Extract<AgentEvent, { type: 'debug.run_snapshot.created' }> | null = null;
  let modelInputMessages: DebugRunModelInputMessage[] | null = null;
  for (const event of events) {
    if (event.type !== 'debug.run_snapshot.created') continue;
    latest = event;
    if (modelInputMessages === null && event.messages?.length) {
      modelInputMessages = event.messages;
    }
  }
  if (!latest) return null;
  // The system prompt / tool schemas can carry a secret embedded by a user-authored
  // agent; redact like every other on-screen string.
  return {
    systemPrompt: redactDisplayText(latest.systemPrompt),
    messages: (modelInputMessages ?? latest.messages ?? []).map((message, index) => (
      messageRow(`model-input-${index}`, message.role, persistedParts(message.content))
    )),
    tools: latest.tools.map((tool): AgentDebugToolEntry => {
      const description = redactDisplayText(tool.description);
      const schema = redactDisplayText(tool.schema);
      return {
        name: tool.name,
        description,
        schema,
        bytes: byteLength(tool.name) + byteLength(description) + byteLength(schema),
      };
    }),
  };
}

function extractModelInputMessages(value: unknown): DebugRunModelInputMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: DebugRunModelInputMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const role = stringValue(item.role) || providerInputItemRole(item);
    if (!role || role === 'system' || role === 'developer') continue;
    const content = providerMessageItemToPersisted(item);
    messages.push({ role, content: content.length > 0 ? content : [{ type: 'text', text: '' }] });
  }
  return messages;
}

function providerInputItemRole(item: Record<string, unknown>): string {
  const type = stringValue(item.type);
  if (type === 'function_call' || type === 'custom_tool_call') return 'assistant';
  if (type === 'function_call_output' || type === 'tool_result') return 'tool';
  return '';
}

function providerMessageItemToPersisted(item: Record<string, unknown>): AgentPersistedContent[] {
  const parts: AgentPersistedContent[] = [];
  if ('content' in item) parts.push(...providerContentToPersisted(item.content));
  if (Array.isArray(item.tool_calls)) parts.push(...providerContentToPersisted(item.tool_calls));
  if (parts.length > 0) return parts;
  return providerContentToPersisted(item);
}

function providerContentToPersisted(value: unknown): AgentPersistedContent[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (Array.isArray(value)) return value.flatMap(providerContentToPersisted);
  if (!isRecord(value)) return [];

  const type = stringValue(value.type);
  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    return [{ type: 'text', text: stringValue(value.text) || stringValue(value.content) }];
  }
  if (type === 'thinking') {
    return [{ type: 'thinking', thinking: stringValue(value.thinking) || stringValue(value.text) }];
  }
  if (type === 'tool_use' || type === 'toolCall' || type === 'tool_call' || type === 'function_call' || type === 'custom_tool_call' || (type === 'function' && isRecord(value.function))) {
    const fn = isRecord(value.function) ? value.function : {};
    return [{
      type: 'toolCall',
      id: stringValue(value.id) || stringValue(value.call_id) || stringValue(value.toolUseId) || stringValue(value.tool_call_id) || 'tool-call',
      name: stringValue(value.name) || stringValue(value.toolName) || stringValue(fn.name) || 'tool',
      arguments: recordValue(value.input) ?? recordValue(value.arguments) ?? parseJsonRecord(stringValue(value.arguments)) ?? parseJsonRecord(stringValue(fn.arguments)) ?? recordValue(fn.arguments) ?? {},
    }];
  }
  if (type === 'function_call_output') {
    const callId = stringValue(value.call_id) || stringValue(value.id);
    const text = providerContentToPersisted(value.output)
      .map((part) => persistedText([part]))
      .filter(Boolean)
      .join('\n');
    return [{ type: 'text', text: formatAgentDebugToolResultText(callId, text) }];
  }
  if (type === 'tool_result') {
    const toolUseId = stringValue(value.tool_use_id) || stringValue(value.toolUseId);
    const text = providerContentToPersisted(value.content)
      .map((part) => persistedText([part]))
      .filter(Boolean)
      .join('\n');
    return [{ type: 'text', text: formatAgentDebugToolResultText(toolUseId, text) }];
  }
  if (type === 'input_file' || type === 'file') {
    return [{ type: 'text', text: `[file ${stringValue(value.filename) || stringValue(value.name) || 'attachment'}]` }];
  }
  if (type === 'image' || type === 'input_image') return [{ type: 'text', text: stringValue(value.alt) || '[image]' }];
  if ('text' in value || 'content' in value) {
    const text = stringValue(value.text) || stringValue(value.content);
    if (text) return [{ type: 'text', text }];
  }
  return [{ type: 'text', text: stableJson(value) }];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return recordValue(parsed);
  } catch {
    return null;
  }
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

function firstNonEmptyMessages(values: DebugRunModelInputMessage[][]): DebugRunModelInputMessage[] {
  for (const value of values) if (value.length > 0) return value;
  return [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- helpers ---------------------------------------------------------------

function persistedParts(content: readonly AgentPersistedContent[]): AgentDebugMessagePart[] {
  // Everything on this surface is read-only but on screen, so every rendered
  // string is redacted: message text, thinking, and tool-call arguments alike can
  // carry a pasted/echoed credential ([[agent-debug-run-grounded]]).
  return content.map((part): AgentDebugMessagePart => {
    if (part.type === 'text') return { kind: 'text', body: redactDisplayText(part.text), isReminder: part.text.startsWith('<system-reminder>') };
    if (part.type === 'thinking') return { kind: 'thinking', body: part.redacted ? '[redacted thinking]' : redactDisplayText(part.thinking) };
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
 * round still in flight; a `tool_result.replaced` (output slimming, spliced into
 * this run's events by matching `toolCallId`) lands on whichever earlier round
 * made the call — so we search the in-flight round first, then the rest. `isError`
 * is left untouched when undefined (replacements don't restate it).
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
  const cost = usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    costUsd: cost.total ?? 0,
    cost: {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cacheRead ?? 0,
      cacheWrite: cost.cacheWrite ?? 0,
      total: cost.total ?? 0,
    },
  };
}

/** Roll up the rounds' own usage — the live total before `meta.usage` is written. */
function aggregateRoundUsage(rounds: readonly AgentDebugRound[]): AgentDebugUsage | null {
  return sumUsages(rounds.map((round) => round.usage).filter((usage): usage is AgentDebugUsage => usage !== null));
}

function sumUsages(usages: readonly AgentDebugUsage[]): AgentDebugUsage | null {
  if (usages.length === 0) return null;
  const totals: AgentDebugUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const usage of usages) addUsage(totals, usage);
  return totals;
}

function emptyDebugTotals(): AgentDebugTotals {
  return {
    queries: 0,
    rounds: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(totals: AgentDebugUsage, usage: AgentDebugUsage) {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.totalTokens += usage.totalTokens;
  totals.costUsd += usage.costUsd;
  totals.cost.input += usage.cost.input;
  totals.cost.output += usage.cost.output;
  totals.cost.cacheRead += usage.cost.cacheRead;
  totals.cost.cacheWrite += usage.cost.cacheWrite;
  totals.cost.total += usage.cost.total;
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

/**
 * The single redaction gate for everything the (read-only but on-screen) debug
 * view renders. Free text — user/assistant text, thinking, tool results, the
 * system prompt, tool descriptions/schemas — passes through here, as does the
 * serialized form of structured values (via {@link sanitizedJson}). Layers all
 * three passes from `agentSecretRedaction`: secret-keyed object values, value
 * patterns over the text, and large-blob elision.
 */
function redactDisplayText(value: string): string {
  return elideLargeBlobs(redactSecretLikeContent(value));
}

/** Pretty-print a structured value with every redaction pass applied. */
function sanitizedJson(value: unknown): string {
  return redactDisplayText(stableJson(redactSecretKeyedValues(value)));
}

const TEXT_ENCODER = new TextEncoder();

function byteLength(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}
