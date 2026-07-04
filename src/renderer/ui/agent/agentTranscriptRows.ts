import type {
  AgentConversationMessage,
  AgentMessage,
  AssistantMessage,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from '../../../core/agentTypes';
import { isSystemReminderBlock } from '../../../core/agentAttachments';
import type { AgentRenderRunEntity } from '../../../core/agentRenderProjection';
import type { AgentMessageEntry, AgentTurnPhase } from '../../agent/runtime';
import {
  type AssistantEntry,
  mergeAssistantEntries,
  sameAssistantActor,
} from './agentConversationRows';

export type AgentTranscriptRenderRow =
  | {
      type: 'message';
      key: string;
      contentKey: string;
      entry: AgentMessageEntry;
      streaming: boolean;
      turnPhase: AgentTurnPhase;
    }
  | {
      type: 'orphan-tool-result';
      key: string;
      message: ToolResultMessage;
    };

function messageKey(message: AgentConversationMessage, index: number): string {
  if (message.role === 'assistant') {
    const firstToolCall = message.content.find((block) => block.type === 'toolCall');
    if (firstToolCall?.type === 'toolCall') return `assistant:${message.timestamp}:${firstToolCall.id}:${index}`;
  }
  return `${message.role}:${message.timestamp}:${index}`;
}

function isHiddenOnlyUserMessage(message: UserMessage): boolean {
  if (typeof message.content === 'string') return isSystemReminderBlock(message.content);
  const textBlocks = message.content.filter((block): block is TextContent => block.type === 'text');
  const hasImages = message.content.some((block) => block.type === 'image');
  return !hasImages && textBlocks.length > 0 && textBlocks.every((block) => isSystemReminderBlock(block.text));
}

function isLastAssistantAt(messages: readonly AgentMessage[], index: number): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === 'assistant') return i === index;
  }
  return false;
}

function turnPhaseForMessage(
  message: AgentConversationMessage,
  active: boolean,
  pendingToolCallIds: ReadonlySet<string>,
): AgentTurnPhase {
  if (!active || message.role !== 'assistant') return 'idle';
  return pendingToolCallIds.size > 0 ? 'waiting_for_tool' : 'streaming_text';
}

function runDurationMsForMessage(run: AgentRenderRunEntity | undefined, lastAssistant: boolean): number | null {
  if (!run || !lastAssistant || run.completedAt === undefined) return null;
  return Math.max(0, run.completedAt - run.startedAt);
}

// Run start for the live "Working for {t}" ticker - only while it is the
// active last turn AND has not completed, so a sealed/failed run never keeps
// ticking.
function runStartedAtMsForMessage(run: AgentRenderRunEntity | undefined, lastAssistant: boolean): number | null {
  if (!run || !lastAssistant || run.completedAt !== undefined) return null;
  return run.startedAt;
}

function turnInterruptedForMessage(run: AgentRenderRunEntity | undefined, lastAssistant: boolean): boolean {
  return !!run && lastAssistant && (run.status === 'failed' || run.status === 'stopped');
}

function entryFromMessage(
  message: AgentConversationMessage,
  index: number,
  active: boolean,
  pendingToolCallIds: ReadonlySet<string>,
  run: AgentRenderRunEntity | undefined,
  lastAssistant: boolean,
): {
  entry: AgentMessageEntry;
  turnPhase: AgentTurnPhase;
} {
  const id = messageKey(message, index);
  return {
    entry: {
      id,
      kind: 'message',
      nodeId: null,
      message,
      branches: null,
      streaming: active,
      actor: null,
      runId: null,
      runDurationMs: runDurationMsForMessage(run, lastAssistant),
      runStartedAtMs: runStartedAtMsForMessage(run, lastAssistant),
      turnInterrupted: turnInterruptedForMessage(run, lastAssistant),
    },
    turnPhase: turnPhaseForMessage(message, active, pendingToolCallIds),
  };
}

function assistantToolCallIdsForMessages(messages: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall') ids.add(block.id);
    }
  }
  return ids;
}

function assistantEntryFromMessage({
  active,
  index,
  message,
  messages,
  pendingToolCallIds,
  run,
}: {
  active: boolean;
  index: number;
  message: AssistantMessage;
  messages: readonly AgentMessage[];
  pendingToolCallIds: ReadonlySet<string>;
  run: AgentRenderRunEntity | undefined;
}): AssistantEntry {
  const lastAssistant = isLastAssistantAt(messages, index);
  const messageActive = active && lastAssistant;
  return entryFromMessage(
    message,
    index,
    messageActive,
    pendingToolCallIds,
    run,
    lastAssistant,
  ).entry as AssistantEntry;
}

function assistantTurnKey(entries: readonly AssistantEntry[]): string {
  const first = entries[0]!;
  return `assistant-turn:${first.id}`;
}

function buildAssistantRow({
  active,
  entries,
  lastAssistantIndex,
  messages,
  pendingToolCallIds,
}: {
  active: boolean;
  entries: AssistantEntry[];
  lastAssistantIndex: number;
  messages: readonly AgentMessage[];
  pendingToolCallIds: ReadonlySet<string>;
}): AgentTranscriptRenderRow {
  const mergedEntry = entries.length >= 2 ? mergeAssistantEntries(entries) : entries[0]!;
  const lastAssistant = isLastAssistantAt(messages, lastAssistantIndex);
  const streaming = active && lastAssistant;
  const contentKey = assistantTurnKey(entries);
  return {
    type: 'message',
    key: contentKey,
    contentKey,
    entry: mergedEntry,
    streaming,
    turnPhase: turnPhaseForMessage(mergedEntry.message, streaming, pendingToolCallIds),
  };
}

export function buildAgentTranscriptRenderRows({
  active = false,
  messages,
  pendingToolCallIds,
  run,
}: {
  active?: boolean;
  messages: readonly AgentMessage[];
  pendingToolCallIds: ReadonlySet<string>;
  run?: AgentRenderRunEntity;
}): AgentTranscriptRenderRow[] {
  const assistantToolCallIds = assistantToolCallIdsForMessages(messages);
  const rows: AgentTranscriptRenderRow[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index]!;

    if (message.role === 'toolResult') {
      if (!assistantToolCallIds.has(message.toolCallId)) {
        rows.push({
          type: 'orphan-tool-result',
          key: `tool-result:${message.toolCallId}:${index}`,
          message,
        });
      }
      index += 1;
      continue;
    }

    if (message.role === 'user') {
      if (!isHiddenOnlyUserMessage(message)) {
        const { entry, turnPhase } = entryFromMessage(message, index, false, pendingToolCallIds, run, false);
        rows.push({
          type: 'message',
          key: entry.id,
          contentKey: entry.id,
          entry,
          streaming: false,
          turnPhase,
        });
      }
      index += 1;
      continue;
    }

    const assistantEntries: AssistantEntry[] = [];
    let cursor = index;
    let lastAssistantIndex = index;

    while (cursor < messages.length) {
      const candidate = messages[cursor]!;
      if (candidate.role === 'toolResult' && assistantToolCallIds.has(candidate.toolCallId)) {
        cursor += 1;
        continue;
      }
      if (candidate.role !== 'assistant') break;

      const candidateEntry = assistantEntryFromMessage({
        active,
        index: cursor,
        message: candidate,
        messages,
        pendingToolCallIds,
        run,
      });
      if (assistantEntries.length > 0 && !sameAssistantActor(assistantEntries[0]!, candidateEntry)) break;

      assistantEntries.push(candidateEntry);
      lastAssistantIndex = cursor;
      cursor += 1;
    }

    rows.push(buildAssistantRow({
      active,
      entries: assistantEntries,
      lastAssistantIndex,
      messages,
      pendingToolCallIds,
    }));
    index = cursor;
  }

  return rows;
}
