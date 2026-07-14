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
  onOpenRunTranscript: ((runId: string) => void) | undefined,
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
  showProcessStatus = true,
  showFinalMessages = true,
  showProcessDetails = true,
  directSubRuns?: readonly AgentRenderRunEntity[],
  toolCallOutcomes?: ReadonlyMap<string, AgentToolCallOutcome>,
) {
  const rendered: ReactNode[] = [];
  const turn = projectAssistantTurn({
    contentKey,
    isChannel,
    message,
    directSubRuns,
    runStartedAtMs,
    showProcessStatus,
    streaming,
    subRunsByParentToolCallId,
    toolCallOutcomes,
    turnActive,
    turnInterrupted,
    workedForMs,
  });

  if (showProcessDetails && turn.process) {
    // Codex-style turn process: live "Working" rows stay non-interactive, while
    // settled "Worked for ..." rows can fold the process details. Inner
    // reasoning/tool groups keep their own independent disclosures.
    rendered.push(
      <AgentProcessBlock
        conversationId={conversationId}
        expandState={expandState}
        index={documentIndex}
        key={turn.process.id}
        onNodeReferenceOpen={onNodeReferenceOpen}
        onOpenRunTranscript={onOpenRunTranscript}
        pendingToolCallIds={pendingToolCallIds}
        process={turn.process}
        results={toolResults}
        subRunsByParentToolCallId={subRunsByParentToolCallId}
        turnActive={turnActive}
      />,
    );
  }

  if (showFinalMessages) {
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
  }

  return rendered;
}
