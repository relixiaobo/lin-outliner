import type { AssistantMessage } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import { looksLikeRawAgentErrorPayload } from './agentErrorParse';

type AssistantContentBlock = AssistantMessage['content'][number];
type AssistantTextBlock = Extract<AssistantContentBlock, { type: 'text' }>;
type AssistantToolCallBlock = Extract<AssistantContentBlock, { type: 'toolCall' }>;

export type AgentTurnProcessItem =
  | {
    id: string;
    streaming: boolean;
    text: string;
    type: 'reasoning';
  }
  | AgentTurnMessageItem
  | {
    childRun?: AgentRenderChildRunEntity;
    id: string;
    outcome?: AgentToolCallOutcome;
    toolCall: AssistantToolCallBlock;
    type: 'toolCall';
  };

export type AgentTurnToolCallItem = Extract<AgentTurnProcessItem, { type: 'toolCall' }>;

export interface AgentTurnMessageItem {
  id: string;
  streaming: boolean;
  text: string;
  type: 'agentMessage';
}

export interface AgentTurnProcessProjection {
  answerStarted: boolean;
  id: string;
  items: AgentTurnProcessItem[];
  liveStartedAtMs: number | null;
  showSummaryRow: boolean;
  showWorkDivider: boolean;
  sealed: boolean;
  stopped: boolean;
  surfaceResultlessProcess: boolean;
  turnFailedWithoutProse: boolean;
  workedForMs: number | null;
}

export interface AgentTurnProjection {
  finalMessages: AgentTurnMessageItem[];
  process: AgentTurnProcessProjection | null;
}

export interface ProjectAssistantTurnInput {
  childRunsByParentToolCallId?: ReadonlyMap<string, AgentRenderChildRunEntity>;
  contentKey: string;
  isChannel: boolean;
  message: AssistantMessage;
  runStartedAtMs: number | null;
  streaming: boolean;
  toolCallOutcomes?: ReadonlyMap<string, AgentToolCallOutcome>;
  turnActive: boolean;
  turnInterrupted: boolean;
  workedForMs: number | null;
}

interface IndexedBlock<T extends AssistantContentBlock = AssistantContentBlock> {
  block: T;
  sourceIndex: number;
}

function isTextBlock(indexed: IndexedBlock): indexed is IndexedBlock<AssistantTextBlock> {
  return indexed.block.type === 'text';
}

function visibleAssistantBlocks({
  isError,
  message,
  streaming,
}: {
  isError: boolean;
  message: AssistantMessage;
  streaming: boolean;
}): IndexedBlock[] {
  return message.content
    .map((block, sourceIndex): IndexedBlock => ({ block, sourceIndex }))
    .filter(({ block }) => {
      if (block.type === 'thinking') {
        return !block.redacted && (block.thinking.trim().length > 0 || streaming);
      }
      if (block.type === 'text') {
        if (isError && looksLikeRawAgentErrorPayload(block.text)) return false;
        return block.text.trim().length > 0 || streaming;
      }
      return true;
    });
}

function processItemFromIndexedBlock({
  childRunsByParentToolCallId,
  hasLater,
  indexed,
  processId,
  streaming,
  toolCallOutcomes,
}: {
  childRunsByParentToolCallId?: ReadonlyMap<string, AgentRenderChildRunEntity>;
  hasLater: boolean;
  indexed: IndexedBlock;
  processId: string;
  streaming: boolean;
  toolCallOutcomes?: ReadonlyMap<string, AgentToolCallOutcome>;
}): AgentTurnProcessItem {
  switch (indexed.block.type) {
    case 'thinking':
      return {
        id: `${processId}:reasoning:${indexed.sourceIndex}`,
        streaming: streaming && !hasLater,
        text: indexed.block.thinking,
        type: 'reasoning',
      };
    case 'toolCall':
      return {
        childRun: childRunsByParentToolCallId?.get(indexed.block.id),
        id: `tool:${indexed.block.id}`,
        outcome: toolCallOutcomes?.get(indexed.block.id),
        toolCall: indexed.block,
        type: 'toolCall',
      };
    case 'text':
      return {
        id: `${processId}:agent-message:${indexed.sourceIndex}`,
        streaming: streaming && !hasLater,
        text: indexed.block.text,
        type: 'agentMessage',
      };
  }
  const exhaustive: never = indexed.block;
  return exhaustive;
}

export function projectAssistantTurn({
  childRunsByParentToolCallId,
  contentKey,
  isChannel,
  message,
  runStartedAtMs,
  streaming,
  toolCallOutcomes,
  turnActive,
  turnInterrupted,
  workedForMs,
}: ProjectAssistantTurnInput): AgentTurnProjection {
  const isError = !!message.errorMessage && message.stopReason !== 'aborted';
  const visibleBlocks = visibleAssistantBlocks({
    isError,
    message,
    streaming,
  });

  let lastProcessIndex = -1;
  for (let i = visibleBlocks.length - 1; i >= 0; i -= 1) {
    const candidate = visibleBlocks[i]!;
    if (candidate.block.type === 'thinking' || candidate.block.type === 'toolCall') {
      lastProcessIndex = i;
      break;
    }
  }

  const processId = `process:${contentKey}`;
  const finalBlocks = visibleBlocks.slice(lastProcessIndex + 1);
  const finalTextBlocks = finalBlocks.filter(isTextBlock);
  const finalIsProse = finalTextBlocks.some(({ block }) => block.text.trim().length > 0);
  const processSettled = finalIsProse && !turnActive;
  const turnInterruptedAndSettled = turnInterrupted && !turnActive;
  const stopped = turnInterruptedAndSettled && message.stopReason === 'aborted';
  const turnFailedWithoutProse = turnInterruptedAndSettled && !finalIsProse && !stopped;
  const surfaceResultlessProcess = !finalIsProse && !stopped && (turnInterruptedAndSettled || (!isChannel && !turnActive));

  const finalMessages: AgentTurnMessageItem[] = finalTextBlocks.map(({ block, sourceIndex }, index) => {
    const hasLaterText = finalTextBlocks.slice(index + 1).some((candidate) => candidate.block.text.trim().length > 0);
    return {
      id: `${processId}:final:${sourceIndex}`,
      streaming: streaming && !hasLaterText,
      text: block.text,
      type: 'agentMessage',
    };
  });

  const showWorkDivider = turnActive
    || stopped
    || (workedForMs !== null && finalIsProse && !turnInterruptedAndSettled);
  const showSummaryRow = lastProcessIndex >= 0 && !showWorkDivider && !turnFailedWithoutProse;

  if (lastProcessIndex < 0 && !showWorkDivider) {
    return { finalMessages, process: null };
  }

  const processEntryEnd = Math.max(0, lastProcessIndex + 1);
  const items = visibleBlocks
    .slice(0, processEntryEnd)
    .map((indexed, localIndex) => processItemFromIndexedBlock({
      childRunsByParentToolCallId,
      hasLater: localIndex < visibleBlocks.length - 1,
      indexed,
      processId,
      streaming,
      toolCallOutcomes,
    }));

  return {
    finalMessages,
    process: {
      answerStarted: finalIsProse,
      id: processId,
      items,
      liveStartedAtMs: runStartedAtMs,
      showSummaryRow,
      showWorkDivider,
      sealed: processSettled,
      stopped,
      surfaceResultlessProcess,
      turnFailedWithoutProse,
      workedForMs,
    },
  };
}
