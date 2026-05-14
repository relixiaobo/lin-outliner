import type { Model } from '@earendil-works/pi-ai';
import type {
  AgentDebugMessagePart,
  AgentDebugMessageRow,
  AgentDebugReminderSection,
  AgentDebugSnapshot,
  AgentDebugTokenEstimate,
  AgentDebugToolEntry,
  AgentDebugTotals,
  AgentDebugUsage,
  AgentDebugWirePayload,
  AgentMessage,
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
  Usage,
} from '../core/agentTypes';

const REMINDER_OPEN = '<system-reminder>';
const SECRET_KEY_PATTERN = /api[_-]?key|authorization|bearer|secret|password|token/i;

export interface CreateAgentDebugSnapshotInput {
  payload: unknown;
  model: Model<any>;
  queryIndex: number;
  sessionId: string;
  sessionTitle: string | null;
  source: AgentDebugSnapshot['source'];
  turnIndex: number;
}

export function createEmptyDebugTotals(): AgentDebugTotals {
  return {
    queries: 0,
    rounds: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    costInputUsd: 0,
    costOutputUsd: 0,
    costCacheReadUsd: 0,
    costCacheWriteUsd: 0,
  };
}

export function createAgentDebugSnapshot(input: CreateAgentDebugSnapshotInput): AgentDebugSnapshot {
  const sanitizedPayload = sanitizeForDebug(input.payload);
  const wireJson = stableJson(sanitizedPayload);
  const wire: AgentDebugWirePayload = {
    json: wireJson,
    bytes: byteLength(wireJson),
    hash: debugHash(wireJson),
  };

  const extracted = extractPayload(sanitizedPayload);
  const systemPrompt = extracted.systemPrompt;
  const remindersBytes = extracted.reminders.reduce((sum, reminder) => sum + reminder.bytes, 0);
  const toolsBytes = extracted.tools.reduce((sum, tool) => sum + tool.bytes, 0);
  const messagesBytes = extracted.messages.reduce((sum, message) => sum + message.bytes, 0);
  const contextWindow = typeof input.model.contextWindow === 'number' ? input.model.contextWindow : null;

  return {
    id: `${input.sessionId}:${input.turnIndex}:${Date.now()}`,
    source: input.source,
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle,
    turnIndex: input.turnIndex,
    queryIndex: input.queryIndex,
    capturedAt: Date.now(),
    modelId: input.model.id,
    provider: input.model.provider,
    status: input.source === 'provider_payload' ? 'running' : 'completed',
    wire,
    systemPrompt,
    systemPromptBytes: byteLength(systemPrompt),
    systemPromptHash: debugHash(systemPrompt),
    reminders: extracted.reminders,
    remindersBytes,
    remindersHash: debugHash(extracted.reminders.map((reminder) => reminder.body).join('\n')),
    tools: extracted.tools,
    toolsBytes,
    toolsHash: debugHash(extracted.tools.map((tool) => `${tool.name}|${tool.schema}`).join('|')),
    messages: extracted.messages,
    messageCount: extracted.messages.length,
    messagesBytes,
    tokenEstimate: createTokenEstimate({
      systemPromptBytes: byteLength(systemPrompt),
      toolsBytes,
      messagesBytes,
      contextWindow,
    }),
    usage: null,
    responseParts: [],
    errorMessage: null,
  };
}

export function createRuntimeStateDebugSnapshot(input: {
  messages: AgentMessage[];
  model: Model<any>;
  queryIndex: number;
  sessionId: string;
  sessionTitle: string | null;
  systemPrompt: string;
  thinkingLevel: string;
  tools: unknown[];
}): AgentDebugSnapshot {
  return createAgentDebugSnapshot({
    payload: {
      source: 'runtime_state',
      systemPrompt: input.systemPrompt,
      model: {
        id: input.model.id,
        provider: input.model.provider,
        api: input.model.api,
        contextWindow: input.model.contextWindow,
      },
      thinkingLevel: input.thinkingLevel,
      tools: input.tools,
      messages: input.messages,
    },
    model: input.model,
    queryIndex: input.queryIndex,
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle,
    source: 'runtime_state',
    turnIndex: 0,
  });
}

export function patchDebugSnapshotWithAssistant(
  snapshot: AgentDebugSnapshot,
  message: AssistantMessage,
): AgentDebugUsage | null {
  snapshot.status = statusFromStopReason(message.stopReason);
  snapshot.errorMessage = typeof message.errorMessage === 'string' && message.errorMessage.length > 0
    ? message.errorMessage
    : null;
  snapshot.responseParts = partsFromAssistantContent(message.content);
  if (!message.usage) return null;
  const usage = usageFromAssistant(message.usage);
  const firstUsagePatch = snapshot.usage === null;
  snapshot.usage = usage;
  return firstUsagePatch ? usage : null;
}

export function sweepRunningDebugSnapshots(
  snapshots: AgentDebugSnapshot[],
  status: AgentDebugSnapshot['status'] = 'completed',
) {
  for (const snapshot of snapshots) {
    if (snapshot.status === 'running') snapshot.status = status;
  }
}

export function addUsageToDebugTotals(totals: AgentDebugTotals, usage: AgentDebugUsage) {
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

export function cloneDebug<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createTokenEstimate(input: {
  systemPromptBytes: number;
  toolsBytes: number;
  messagesBytes: number;
  contextWindow: number | null;
}): AgentDebugTokenEstimate {
  const systemPrompt = estimateTokens(input.systemPromptBytes);
  const tools = estimateTokens(input.toolsBytes);
  const messages = estimateTokens(input.messagesBytes);
  const total = systemPrompt + tools + messages;
  return {
    systemPrompt,
    tools,
    messages,
    total,
    contextWindow: input.contextWindow,
    usagePercent: input.contextWindow && input.contextWindow > 0
      ? Math.min(100, (total / input.contextWindow) * 100)
      : null,
  };
}

function usageFromAssistant(usage: Usage): AgentDebugUsage {
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

function statusFromStopReason(stopReason: AssistantMessage['stopReason']): AgentDebugSnapshot['status'] {
  if (stopReason === 'aborted') return 'aborted';
  if (stopReason === 'error') return 'error';
  return 'completed';
}

function extractPayload(payload: unknown): {
  systemPrompt: string;
  reminders: AgentDebugReminderSection[];
  tools: AgentDebugToolEntry[];
  messages: AgentDebugMessageRow[];
} {
  if (!isRecord(payload)) {
    const json = stableJson(payload);
    return {
      systemPrompt: '',
      reminders: [],
      tools: [],
      messages: [{
        id: 'payload',
        role: 'payload',
        summary: truncate(json, 80),
        json,
        bytes: byteLength(json),
        parts: [{ kind: 'json', body: json }],
      }],
    };
  }

  const systemPrompt = firstNonEmpty([
    extractSystemPrompt(payload.system),
    extractSystemPrompt(payload.instructions),
    extractSystemPrompt(payload.systemPrompt),
  ]);
  const tools = extractTools(payload.tools);
  const rawMessages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : [];
  const messages = extractMessages(rawMessages);

  return {
    systemPrompt,
    reminders: extractReminders(messages),
    tools,
    messages,
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

function extractTools(value: unknown): AgentDebugToolEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((rawTool, index) => {
    const tool = isRecord(rawTool) ? rawTool : {};
    const fn = isRecord(tool.function) ? tool.function : {};
    const name = stringValue(tool.name) || stringValue(fn.name) || `tool_${index + 1}`;
    const description = stringValue(tool.description) || stringValue(fn.description) || '';
    const schemaValue = tool.input_schema ?? tool.parameters ?? fn.parameters ?? tool.schema ?? {};
    const schema = stableJson(schemaValue);
    return {
      name,
      description,
      schema,
      bytes: byteLength(name) + byteLength(description) + byteLength(schema),
    };
  });
}

function extractMessages(value: unknown[]): AgentDebugMessageRow[] {
  return value.map((message, index) => {
    const json = stableJson(message);
    const role = isRecord(message)
      ? stringValue(message.role) || stringValue(message.type) || 'message'
      : 'message';
    const parts = extractMessageParts(message);
    return {
      id: `${index}`,
      role,
      summary: summarizeMessage(role, parts, json),
      json,
      bytes: byteLength(json),
      parts,
    };
  });
}

function extractMessageParts(message: unknown): AgentDebugMessagePart[] {
  if (typeof message === 'string') return [{ kind: 'text', body: message }];
  if (!isRecord(message)) return [{ kind: 'json', body: stableJson(message) }];

  const parts: AgentDebugMessagePart[] = [];
  const content = message.content ?? message.input ?? message.output;
  if (typeof content === 'string') {
    parts.push({
      kind: message.role === 'tool' ? 'toolResult' : 'text',
      body: content,
      toolUseId: stringValue(message.tool_call_id) || '',
      isError: message.is_error === true || message.isError === true,
    } as AgentDebugMessagePart);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      parts.push(...extractContentBlockParts(block));
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const part = extractOpenAiToolCall(toolCall);
      if (part) parts.push(part);
    }
  }

  if (parts.length === 0 && typeof message.arguments === 'object') {
    const fn = isRecord(message.function) ? message.function : {};
    const name = stringValue(message.name) || stringValue(fn.name) || 'tool_call';
    parts.push({
      kind: 'toolCall',
      name,
      toolUseId: stringValue(message.id) || '',
      body: stableJson(message.arguments),
    });
  }

  if (parts.length === 0) parts.push({ kind: 'json', body: stableJson(message) });
  return parts;
}

function extractContentBlockParts(block: unknown): AgentDebugMessagePart[] {
  if (typeof block === 'string') return [{ kind: 'text', body: block }];
  if (!isRecord(block)) return [{ kind: 'json', body: stableJson(block) }];
  const type = stringValue(block.type);
  const text = stringValue(block.text)
    || stringValue(block.input_text)
    || stringValue(block.output_text)
    || stringValue(block.content);

  if (type === 'thinking' || type === 'reasoning') {
    return [{ kind: 'thinking', body: text || stringValue(block.thinking) || '[thinking]' }];
  }
  if (type === 'tool_use' || type === 'toolCall' || type === 'tool_call' || type === 'function_call') {
    const fn = isRecord(block.function) ? block.function : {};
    return [{
      kind: 'toolCall',
      name: stringValue(block.name) || stringValue(fn.name) || 'tool_call',
      toolUseId: stringValue(block.id) || stringValue(block.call_id) || '',
      body: stableJson(block.input ?? block.arguments ?? fn.arguments ?? {}),
    }];
  }
  if (type === 'tool_result' || type === 'function_call_output') {
    return [{
      kind: 'toolResult',
      toolUseId: stringValue(block.tool_use_id) || stringValue(block.call_id) || '',
      body: text || stableJson(block.content ?? block.output ?? ''),
      isError: block.is_error === true || block.isError === true,
    }];
  }
  if (type === 'image' || type === 'input_image') {
    return [{ kind: 'image', body: stringValue(block.masked) || '[image]' }];
  }
  if (text) {
    return [{ kind: 'text', body: text, isReminder: text.startsWith(REMINDER_OPEN) }];
  }
  return [{ kind: 'json', body: stableJson(block) }];
}

function extractOpenAiToolCall(toolCall: unknown): AgentDebugMessagePart | null {
  if (!isRecord(toolCall)) return null;
  const fn = isRecord(toolCall.function) ? toolCall.function : {};
  return {
    kind: 'toolCall',
    name: stringValue(fn.name) || stringValue(toolCall.name) || 'tool_call',
    toolUseId: stringValue(toolCall.id) || '',
    body: typeof fn.arguments === 'string' ? fn.arguments : stableJson(fn.arguments ?? toolCall.arguments ?? {}),
  };
}

function extractReminders(messages: AgentDebugMessageRow[]): AgentDebugReminderSection[] {
  const sections: AgentDebugReminderSection[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') continue;
    for (const part of message.parts) {
      if (part.kind === 'text' && part.body.startsWith(REMINDER_OPEN)) {
        sections.push({ body: part.body, bytes: byteLength(part.body) });
      }
    }
    break;
  }
  return sections.reverse();
}

function partsFromAssistantContent(content: AssistantMessage['content']): AgentDebugMessagePart[] {
  return content.map((block): AgentDebugMessagePart => {
    if (block.type === 'text') return { kind: 'text', body: block.text };
    if (block.type === 'thinking') {
      return { kind: 'thinking', body: block.redacted ? '[redacted thinking]' : block.thinking };
    }
    return partFromToolCall(block);
  });
}

function partFromToolCall(block: ToolCall): AgentDebugMessagePart {
  return {
    kind: 'toolCall',
    name: block.name,
    toolUseId: block.id,
    body: stableJson(block.arguments ?? {}),
  };
}

function summarizeMessage(role: string, parts: AgentDebugMessagePart[], fallbackJson: string): string {
  const firstText = parts.find((part) => part.kind === 'text' && !part.isReminder);
  if (firstText?.kind === 'text') return `${role}: ${truncate(firstText.body, 72)}`;
  const toolCallCount = parts.filter((part) => part.kind === 'toolCall').length;
  const toolResultCount = parts.filter((part) => part.kind === 'toolResult').length;
  const imageCount = parts.filter((part) => part.kind === 'image').length;
  const labels = [
    toolCallCount ? `${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}` : '',
    toolResultCount ? `${toolResultCount} tool result${toolResultCount === 1 ? '' : 's'}` : '',
    imageCount ? `${imageCount} image${imageCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return labels.length ? `${role}: ${labels.join(', ')}` : `${role}: ${truncate(fallbackJson, 72)}`;
}

export function summarizeToolResultMessage(message: ToolResultMessage): AgentDebugMessagePart {
  return {
    kind: 'toolResult',
    toolUseId: message.toolCallId,
    body: stableJson(message.content),
    isError: message.isError,
  };
}

function sanitizeForDebug(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeForDebug);
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = '[redacted]';
      continue;
    }
    if (key === 'data' && typeof item === 'string' && item.length > 256) {
      output[key] = `[base64 elided: ${item.length} chars]`;
      continue;
    }
    if (key === 'source' && isRecord(item) && typeof item.data === 'string') {
      const sanitizedSource = sanitizeForDebug(item);
      output[key] = {
        ...(isRecord(sanitizedSource) ? sanitizedSource : {}),
        data: `[base64 elided: ${item.data.length} chars]`,
      };
      continue;
    }
    output[key] = sanitizeForDebug(item);
  }
  return output;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function debugHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstNonEmpty(values: string[]): string {
  return values.find((value) => value.trim().length > 0) ?? '';
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}
