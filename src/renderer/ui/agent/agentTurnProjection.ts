import type { AssistantMessage, ToolCall } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderRunEntity } from '../../../core/agentRenderProjection';
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
    id: string;
    outcome?: AgentToolCallOutcome;
    subRun?: AgentRenderRunEntity;
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
  contentKey: string;
  directSubRuns?: readonly AgentRenderRunEntity[];
  isChannel: boolean;
  message: AssistantMessage;
  runStartedAtMs: number | null;
  streaming: boolean;
  subRunsByParentToolCallId?: ReadonlyMap<string, AgentRenderRunEntity>;
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
  hasLater,
  indexed,
  processId,
  streaming,
  subRunsByParentToolCallId,
  toolCallOutcomes,
}: {
  hasLater: boolean;
  indexed: IndexedBlock;
  processId: string;
  streaming: boolean;
  subRunsByParentToolCallId?: ReadonlyMap<string, AgentRenderRunEntity>;
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
        id: `tool:${indexed.block.id}`,
        outcome: toolCallOutcomes?.get(indexed.block.id),
        subRun: subRunsByParentToolCallId?.get(indexed.block.id),
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

function syntheticSkillNameForRun(run: AgentRenderRunEntity): string {
  if (run.runProfile === 'research') return 'research';
  return run.runProfile;
}

function directSubRunProcessItem(run: AgentRenderRunEntity): AgentTurnProcessItem {
  const toolCall: ToolCall = {
    arguments: {
      args: run.title,
      skill: syntheticSkillNameForRun(run),
    },
    id: `direct-run:${run.id}`,
    name: 'skill',
    type: 'toolCall',
  };
  return {
    id: `direct-run:${run.id}`,
    subRun: run,
    toolCall,
    type: 'toolCall',
  };
}

export function projectAssistantTurn({
  contentKey,
  directSubRuns = [],
  isChannel,
  message,
  runStartedAtMs,
  streaming,
  subRunsByParentToolCallId,
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
  const directSubRunItems = directSubRuns.map(directSubRunProcessItem);

  if (lastProcessIndex < 0 && !showWorkDivider && directSubRunItems.length === 0) {
    return { finalMessages, process: null };
  }

  const processEntryEnd = Math.max(0, lastProcessIndex + 1);
  const items = visibleBlocks
    .slice(0, processEntryEnd)
    .map((indexed, localIndex) => processItemFromIndexedBlock({
      hasLater: localIndex < visibleBlocks.length - 1,
      indexed,
      processId,
      streaming,
      subRunsByParentToolCallId,
      toolCallOutcomes,
    }))
    .concat(directSubRunItems);

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
