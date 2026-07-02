import type { ReactNode } from 'react';
import type { AssistantMessage, AgentToolResultWithPayloads } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderRunEntity } from '../../../core/agentRenderProjection';
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
  subRunsByParentToolCallId: Map<string, AgentRenderRunEntity> | undefined,
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
    contentKey,
    isChannel,
    message,
    runStartedAtMs,
    streaming,
    subRunsByParentToolCallId,
    toolCallOutcomes,
    turnActive,
    turnInterrupted,
    workedForMs,
  });

  if (turn.process) {
    // Codex-style turn process: a non-interactive work divider plus the visible
    // reasoning/interim narration/tool timeline. Only the inner reasoning/tool
    // groups are disclosures; the top-level "Working/Worked for" row is not.
    rendered.push(
      <AgentProcessBlock
        conversationId={conversationId}
        expandState={expandState}
        index={documentIndex}
        key={turn.process.id}
        onNodeReferenceOpen={onNodeReferenceOpen}
        onOpenChildRunTranscript={onOpenChildRunTranscript}
        pendingToolCallIds={pendingToolCallIds}
        process={turn.process}
        results={toolResults}
        subRunsByParentToolCallId={subRunsByParentToolCallId}
        turnActive={turnActive}
      />,
    );
  }

  // Trailing answer prose. The projection owns the result-first split; rendering
  // here is just the final assistant-message items.
  turn.finalMessages.forEach((block) => {
    rendered.push(
      <AgentMarkdown
        index={documentIndex}
        key={block.id}
        keyPrefix={block.id}
        onNodeReferenceOpen={onNodeReferenceOpen}
        streaming={block.streaming}
        text={block.text}
      />,
    );
  });

  return rendered;
}
