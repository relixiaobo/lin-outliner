import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { AgentDebugSnapshot, AgentDebugTotals, TextContent, ThinkingContent, ToolCall } from '../core/agentTypes';
import type {
  AgentEvent,
  AgentPayloadRef,
  AgentPersistedContent,
  AssistantMessageCompletedEvent,
  DebugSnapshotCreatedEvent,
} from '../core/agentEventLog';
import {
  addUsageToDebugTotals,
  createAgentDebugSnapshot,
  createEmptyDebugTotals,
  patchDebugSnapshotWithAssistant,
} from './agentDebug';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export interface AgentDebugProjection {
  history: AgentDebugSnapshot[];
  latestSeq: number;
  totals: AgentDebugTotals;
}

export async function deriveAgentDebugProjectionFromEvents(input: {
  events: readonly AgentEvent[];
  readPayload: (payload: AgentPayloadRef) => Promise<Buffer | Uint8Array | string>;
  sessionId: string;
  sessionTitle?: string | null;
}): Promise<AgentDebugProjection> {
  const latestSeq = input.events.at(-1)?.seq ?? 0;
  const debugEvents = input.events.filter(isDebugSnapshotCreatedEvent).slice(-20);
  const completedAssistantEvents = input.events.filter(isAssistantMessageCompletedEvent);
  const usedAssistantCompletions = new Set<string>();
  const history: AgentDebugSnapshot[] = [];
  const sessionTitle = input.sessionTitle ?? sessionTitleFromEvents(input.events);

  for (let index = 0; index < debugEvents.length; index += 1) {
    const event = debugEvents[index]!;
    const payloadJson = await readDebugPayloadJson(event, input.readPayload);
    const payload = parseDebugPayloadJson(payloadJson, event.payloadRef.id);
    const snapshot = createAgentDebugSnapshot({
      id: event.debugId,
      capturedAt: event.createdAt,
      payload,
      wirePayload: {
        sanitizedPayload: payload,
        json: payloadJson,
        bytes: event.wire.bytes,
        hash: event.wire.hash,
      },
      wirePayloadRef: event.payloadRef,
      model: debugModelFromMetadata(event.model),
      queryIndex: event.queryIndex,
      sessionId: input.sessionId,
      sessionTitle,
      source: event.source,
      turnIndex: event.turnIndex,
    });

    const completed = nextAssistantCompletionForDebugEvent(event, completedAssistantEvents, usedAssistantCompletions);
    if (completed) {
      usedAssistantCompletions.add(completed.eventId);
      patchDebugSnapshotWithAssistant(snapshot, {
        role: 'assistant',
        content: assistantContentFromPersisted(completed.content),
        api: event.model.api ?? '',
        provider: event.model.provider,
        model: event.model.id,
        usage: completed.usage ?? EMPTY_USAGE,
        stopReason: completed.stopReason,
        timestamp: completed.createdAt,
      });
    } else {
      const terminalStatus = debugTerminalStatusAfterEvent(event, input.events, debugEvents[index + 1]?.seq);
      if (terminalStatus) snapshot.status = terminalStatus;
    }

    history.push(snapshot);
  }

  return {
    history,
    latestSeq,
    totals: debugTotalsFromHistory(history),
  };
}

export function isDebugSnapshotCreatedEvent(event: AgentEvent): event is DebugSnapshotCreatedEvent {
  return event.type === 'debug.snapshot.created';
}

export function debugModelMetadata(model: Model<any>): DebugSnapshotCreatedEvent['model'] {
  return {
    id: model.id,
    provider: model.provider,
    api: typeof model.api === 'string' ? model.api : undefined,
    contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : null,
  };
}

async function readDebugPayloadJson(
  event: DebugSnapshotCreatedEvent,
  readPayload: (payload: AgentPayloadRef) => Promise<Buffer | Uint8Array | string>,
): Promise<string> {
  try {
    const bytes = await readPayload(event.payloadRef);
    return typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  } catch {
    return JSON.stringify({
      error: 'Debug payload is unavailable.',
      payloadId: event.payloadRef.id,
    });
  }
}

function isAssistantMessageCompletedEvent(event: AgentEvent): event is AssistantMessageCompletedEvent {
  return event.type === 'assistant_message.completed';
}

function debugModelFromMetadata(model: DebugSnapshotCreatedEvent['model']): Model<any> {
  return {
    id: model.id,
    name: model.id,
    api: model.api ?? 'unknown',
    provider: model.provider,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: model.contextWindow ?? undefined,
    maxTokens: 0,
  } as Model<any>;
}

function parseDebugPayloadJson(json: string, payloadId: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {
      payloadId,
      raw: json,
    };
  }
}

function nextAssistantCompletionForDebugEvent(
  debugEvent: DebugSnapshotCreatedEvent,
  completions: readonly AssistantMessageCompletedEvent[],
  usedCompletions: Set<string>,
): AssistantMessageCompletedEvent | null {
  return completions.find((event) => (
    event.seq > debugEvent.seq
    && !usedCompletions.has(event.eventId)
    && (!debugEvent.runId || event.runId === debugEvent.runId)
  )) ?? null;
}

function debugTerminalStatusAfterEvent(
  debugEvent: DebugSnapshotCreatedEvent,
  events: readonly AgentEvent[],
  nextDebugSeq: number | undefined,
): AgentDebugSnapshot['status'] | null {
  for (const event of events) {
    if (event.seq <= debugEvent.seq) continue;
    if (nextDebugSeq !== undefined && event.seq >= nextDebugSeq) break;
    if (debugEvent.runId && event.runId !== debugEvent.runId) continue;
    if (event.type === 'run.failed') return 'error';
    if (event.type === 'run.cancelled') return 'aborted';
    if (event.type === 'run.completed') return 'completed';
  }
  return nextDebugSeq === undefined ? null : 'completed';
}

function debugTotalsFromHistory(history: readonly AgentDebugSnapshot[]): AgentDebugTotals {
  const totals = createEmptyDebugTotals();
  const queries = new Set<number>();
  for (const snapshot of history) {
    queries.add(snapshot.queryIndex);
    totals.rounds += 1;
    if (snapshot.usage) addUsageToDebugTotals(totals, snapshot.usage);
  }
  totals.queries = queries.size;
  return totals;
}

function sessionTitleFromEvents(events: readonly AgentEvent[]): string | null {
  let title: string | null = null;
  for (const event of events) {
    if (event.type === 'session.created' || event.type === 'session.renamed') title = event.title;
  }
  return title;
}

function assistantContentFromPersisted(content: readonly AgentPersistedContent[]): AssistantMessage['content'] {
  return content.flatMap((part): Array<TextContent | ThinkingContent | ToolCall> => {
    if (part.type === 'text') return [{ type: 'text', text: part.text }];
    if (part.type === 'thinking') return [{ type: 'thinking', thinking: part.thinking, redacted: part.redacted }];
    if (part.type === 'toolCall') {
      return [{
        type: 'toolCall',
        id: part.id,
        name: part.name,
        arguments: part.arguments,
      }];
    }
    return [{ type: 'text', text: persistedContentText(part) }];
  });
}

function persistedContentText(content: AgentPersistedContent): string {
  if (content.type === 'text') return content.text;
  if (content.type === 'thinking') return content.thinking;
  if (content.type === 'toolCall') return `[tool:${content.name}]`;
  if (content.type === 'image') return content.alt || content.imageRef.summary || `[image:${content.imageRef.id}]`;
  return content.label || content.payload.summary || `[payload:${content.payload.id}]`;
}
