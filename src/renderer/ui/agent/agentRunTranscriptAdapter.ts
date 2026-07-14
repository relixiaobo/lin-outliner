import type {
  AgentMessage,
  AgentRunDetailPayload,
  AgentToolResultWithPayloads,
  ToolResultMessage,
} from '../../../core/agentTypes';
import type { AgentRenderRunEntity } from '../../../core/agentRenderProjection';

type AgentRunDetailChild = AgentRunDetailPayload['subRuns'][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value)) return false;
  return value.role === 'user' || value.role === 'assistant' || value.role === 'toolResult';
}

export function parseAgentRunTranscript(raw: unknown[] | null | undefined): AgentMessage[] {
  if (!raw) return [];
  return raw.filter(isAgentMessage);
}

function toolResultFromMessage(message: ToolResultMessage): AgentToolResultWithPayloads {
  return {
    ...message,
    payloadRefs: [],
  };
}

export function buildAgentRunToolResultMap(messages: readonly AgentMessage[]): Map<string, AgentToolResultWithPayloads> {
  const results = new Map<string, AgentToolResultWithPayloads>();
  for (const message of messages) {
    if (message.role !== 'toolResult') continue;
    results.set(message.toolCallId, toolResultFromMessage(message));
  }
  return results;
}

export function collectPendingAgentRunToolCallIds(messages: readonly AgentMessage[], running: boolean): Set<string> {
  if (!running) return new Set();
  const toolResults = buildAgentRunToolResultMap(messages);
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall' && !toolResults.has(block.id)) pending.add(block.id);
    }
  }
  return pending;
}

export function agentRunTranscriptHasActiveAssistantTurn(
  messages: readonly AgentMessage[],
  running: boolean,
  pendingToolCallIds: ReadonlySet<string>,
): boolean {
  if (!running) return false;
  if (pendingToolCallIds.size > 0) return true;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant') return message.stopReason === null;
    if (message.role === 'user') return false;
  }
  return false;
}

export function agentRunDetailToTranscriptRun(detail: AgentRunDetailPayload): AgentRenderRunEntity {
  return {
    id: detail.runId,
    agentId: detail.agentId,
    anchor: detail.conversationId
      ? { type: 'conversation', agentId: detail.agentId, conversationId: detail.conversationId }
      : { type: 'principal', principal: { type: 'agent', agentId: detail.agentId } },
    conversationId: detail.conversationId ?? undefined,
    title: detail.title,
    parentRunId: detail.parentRunId,
    parentToolCallId: detail.parentToolCallId,
    runProfile: detail.runProfile,
    runProfileLabel: detail.runProfileLabel,
    status: detail.status,
    objectiveStatus: detail.objectiveStatus,
    objectiveRole: detail.objectiveRole,
    context: detail.context,
    startedAt: detail.startedAt,
    updatedAt: detail.updatedAt,
    completedAt: detail.completedAt,
  };
}

export function agentRunChildToTranscriptRun(
  child: AgentRunDetailChild,
  parent: AgentRunDetailPayload,
): AgentRenderRunEntity {
  return {
    id: child.runId,
    agentId: parent.agentId,
    anchor: parent.conversationId
      ? { type: 'conversation', agentId: parent.agentId, conversationId: parent.conversationId }
      : { type: 'principal', principal: { type: 'agent', agentId: parent.agentId } },
    conversationId: parent.conversationId ?? undefined,
    title: child.title,
    parentRunId: child.parentRunId,
    parentToolCallId: child.parentToolCallId,
    runProfile: child.runProfile,
    runProfileLabel: child.runProfileLabel,
    status: child.status,
    objectiveStatus: child.objectiveStatus,
    objectiveRole: child.objectiveRole,
    context: parent.context,
    startedAt: child.startedAt,
    updatedAt: child.updatedAt,
    completedAt: child.completedAt,
  };
}

export function agentRunSubRunsByParentToolCallId(
  detail: AgentRunDetailPayload,
): Map<string, AgentRenderRunEntity> | undefined {
  const map = new Map<string, AgentRenderRunEntity>();
  for (const child of [...detail.subRuns, ...detail.verificationRuns]) {
    if (child.parentToolCallId) map.set(child.parentToolCallId, agentRunChildToTranscriptRun(child, detail));
  }
  return map.size > 0 ? map : undefined;
}
