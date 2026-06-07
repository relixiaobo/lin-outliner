import type { AgentMemorySource } from '../core/agentEventLog';
import type { AgentMessage } from '../core/agentTypes';

export interface SubagentTranscriptEnvelope {
  v: 1;
  runId: string;
  executingAgentId?: string;
  parentAgentId?: string;
  memoryOwnerAgentId?: string;
  dreamEvidenceStartMessageIndex?: number;
  messageCount: number;
  messages: AgentMessage[];
}

export function createSubagentTranscriptEnvelope(input: {
  runId: string;
  executingAgentId?: string;
  parentAgentId?: string;
  memoryOwnerAgentId?: string;
  dreamEvidenceStartMessageIndex?: number;
  messages: readonly AgentMessage[];
}): SubagentTranscriptEnvelope {
  const messages = input.messages.filter(isRecordableRuntimeMessage).map(cloneAgentMessage);
  return {
    v: 1,
    runId: input.runId,
    executingAgentId: input.executingAgentId,
    parentAgentId: input.parentAgentId,
    memoryOwnerAgentId: input.memoryOwnerAgentId,
    dreamEvidenceStartMessageIndex: finiteMessageIndex(input.dreamEvidenceStartMessageIndex, messages.length),
    messageCount: messages.length,
    messages,
  };
}

export function parseSubagentTranscriptEnvelope(raw: Uint8Array | string): SubagentTranscriptEnvelope | null {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.runId !== 'string' || !Array.isArray(parsed.messages)) {
    return null;
  }
  const messages = parsed.messages.filter(isRecordableRuntimeMessage).map(cloneAgentMessage);
  return {
    v: 1,
    runId: parsed.runId,
    executingAgentId: stringOrUndefined(parsed.executingAgentId),
    parentAgentId: stringOrUndefined(parsed.parentAgentId),
    memoryOwnerAgentId: stringOrUndefined(parsed.memoryOwnerAgentId),
    dreamEvidenceStartMessageIndex: finiteMessageIndex(parsed.dreamEvidenceStartMessageIndex, messages.length),
    messageCount: typeof parsed.messageCount === 'number' && Number.isFinite(parsed.messageCount)
      ? Math.trunc(parsed.messageCount)
      : messages.length,
    messages,
  };
}

export function agentRunMessageId(runId: string, index: number): string {
  return `${runId}:message:${index + 1}`;
}

export function agentRunMessageIndex(runId: string, messageId: string): number {
  const prefix = `${runId}:message:`;
  if (!messageId.startsWith(prefix)) return -1;
  const numeric = Number(messageId.slice(prefix.length));
  if (!Number.isInteger(numeric) || numeric <= 0) return -1;
  return numeric - 1;
}

export function agentRunSourceMessageWindow(
  source: Pick<AgentMemorySource, 'messageRange'>,
  runId: string,
  messageCount: number,
): { startIndex: number; endIndex: number } | null {
  if (!source.messageRange) return null;
  const [fromMessageId, throughMessageId] = source.messageRange;
  const startIndex = agentRunMessageIndex(runId, fromMessageId);
  if (startIndex < 0 || startIndex >= messageCount) return null;
  const throughIndex = agentRunMessageIndex(runId, throughMessageId);
  const endIndex = throughIndex >= startIndex ? Math.min(throughIndex, messageCount - 1) : startIndex;
  return { startIndex, endIndex };
}

export function subagentDreamEvidenceStartMessageIndex(
  run: { contextMode: 'fresh' | 'fork'; dreamEvidenceStartMessageIndex?: number },
  messageCount: number,
): number {
  if (run.contextMode !== 'fork') return 0;
  if (typeof run.dreamEvidenceStartMessageIndex === 'number' && Number.isFinite(run.dreamEvidenceStartMessageIndex)) {
    return Math.min(messageCount, Math.max(0, Math.trunc(run.dreamEvidenceStartMessageIndex)));
  }
  return messageCount;
}

export function isRecordableRuntimeMessage(message: unknown): message is AgentMessage {
  return isRecord(message)
    && (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult');
}

function cloneAgentMessage(message: AgentMessage): AgentMessage {
  return JSON.parse(JSON.stringify(message)) as AgentMessage;
}

function finiteMessageIndex(value: unknown, messageCount: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(messageCount, Math.max(0, Math.trunc(value)));
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
