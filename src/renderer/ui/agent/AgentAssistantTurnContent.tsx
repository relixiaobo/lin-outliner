import type { ReactNode } from 'react';
import type { AssistantMessage, AgentToolResultWithPayloads } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import {
  AgentProcessBlock,
  type AgentExpandState,
} from './AgentProcessBlock';
import { AgentMarkdown } from './AgentMarkdown';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { projectAssistantTurn } from './agentTurnProjection';

export function renderAssistantBlocks(
  message: AssistantMessage,
  contentKey: string,
  documentIndex: DocumentIndex,
  expandState: AgentExpandState,
  onNodeReferenceOpen: AgentNodeReferenceOpenHandler | undefined,
  onOpenChildRunTranscript: ((childRunId: string) => void) | undefined,
  pendingToolCallIds: ReadonlySet<string>,
  conversationId: string | null | undefined,
  streaming: boolean,
  childRunsByParentToolCallId: Map<string, AgentRenderChildRunEntity> | undefined,
  toolResults: Map<string, AgentToolResultWithPayloads>,
  turnActive: boolean,
  turnInterrupted: boolean,
  isChannel: boolean,
  workedForMs: number | null,
  runStartedAtMs: number | null,
  toolCallOutcomes?: ReadonlyMap<string, AgentToolCallOutcome>,
) {
  const rendered: ReactNode[] = [];
  const turn = projectAssistantTurn({
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
  });

  if (turn.process) {
    // ONE turn-level process fold (Codex machine C). It renders the whole
    // pre-answer body — reasoning, interim narration, and the grouped
    // tool-activity — through AgentProcessTimeline (the inner per-group collapse
    // is machine B). While the turn is still WORKING it shows the body expanded
    // with a live "Working for {t}" header; the moment the final answer starts
    // (`answerStarted`) it auto-collapses to the "Worked for {t}" divider with the
    // answer streaming below.
    rendered.push(
      <AgentProcessBlock
        childRunsByParentToolCallId={childRunsByParentToolCallId}
        conversationId={conversationId}
        expandState={expandState}
        index={documentIndex}
        key={turn.process.id}
        onNodeReferenceOpen={onNodeReferenceOpen}
        onOpenChildRunTranscript={onOpenChildRunTranscript}
        pendingToolCallIds={pendingToolCallIds}
        process={turn.process}
        results={toolResults}
        turnActive={turnActive}
      />,
    );
  }

  // Trailing answer prose. The projection owns the result-first split; rendering
  // here is just the final assistant-message items.
  turn.finalMessages.forEach((block, i) => {
    rendered.push(
      <AgentMarkdown
        index={documentIndex}
        key={`text-${i}`}
        keyPrefix={block.id}
        onNodeReferenceOpen={onNodeReferenceOpen}
        streaming={block.streaming}
        text={block.text}
      />,
    );
  });

  return rendered;
}
