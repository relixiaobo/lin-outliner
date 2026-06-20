import type { ReactNode } from 'react';
import type { AssistantMessage, AgentToolResultWithPayloads } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import {
  AgentProcessBlock,
  type AgentExpandState,
  type AgentProcessSegmentBlock,
} from './AgentProcessBlock';
import { AgentMarkdown } from './AgentMarkdown';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { looksLikeRawAgentErrorPayload } from './agentErrorParse';

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
  const isError = !!message.errorMessage && message.stopReason !== 'aborted';
  const visibleBlocks = message.content.filter((block) => {
    if (block.type === 'thinking') {
      return !block.redacted && (block.thinking.trim().length > 0 || streaming);
    }
    if (block.type === 'text') {
      if (isError && looksLikeRawAgentErrorPayload(block.text)) return false;
      return block.text.trim().length > 0 || streaming;
    }
    // A child-run-spawn tool call: in a Channel the run surfaces as its
    // own inline transcript boundary (AgentChildRunBoundary) right after this turn,
    // so drop its tool-call block here to avoid showing it twice. In a DM the run
    // folds into THIS turn's process instead — the tool-call row renders the
    // child-run summary + result inline, turn-anchored so an edit removes it — so it
    // stays. The projection's insertChildRunRows skips the DM boundary in lockstep.
    if (block.type === 'toolCall' && isChannel && childRunsByParentToolCallId?.has(block.id)) return false;
    return true;
  });
  // Result-first turn: the final answer is the trailing text after the last
  // thinking/toolCall block. Everything before it — thinking, tool calls, AND
  // interim narration text — folds into ONE process disclosure; the trailing
  // text renders as the visible answer. A turn with no thinking/tools is a
  // direct answer and renders without a fold.
  let lastProcessIndex = -1;
  for (let i = visibleBlocks.length - 1; i >= 0; i -= 1) {
    const candidate = visibleBlocks[i]!;
    if (candidate.type === 'thinking' || candidate.type === 'toolCall') {
      lastProcessIndex = i;
      break;
    }
  }
  // The trailing answer prose, after the last process block. `finalIsProse`
  // identifies the result-first split: WITH trailing prose the process can rest
  // behind the answer; WITHOUT it the turn produced no result. The process does
  // not enter that resting state until the turn is no longer active, so DM final
  // prose can stream below the still-expanded process, then collapse on settle
  // (Codex-style).
  //
  // Two SEPARATE concerns, both keyed off this — decoupled so a Channel never
  // mislabels:
  //  • `turnFailedWithoutProse` (the alarming RED "Interrupted" label + error
  //    styling) fires ONLY when the run actually failed/was cancelled/crashed
  //    (`turnInterrupted`, derived in core from the run's REAL status — never from
  //    block structure). A cleanly `completed` resultless turn is NEVER red.
  //  • `surfaceResultlessProcess` (auto-expand the process so its interim work
  //    isn't buried) fires for a genuine interruption in EITHER mode, AND — per
  //    the #240 result-first design — for a sealed resultless **DM** turn, where
  //    the user watched it 1:1. A Channel delivers atomically (its process lives
  //    in the activity detail view, not inline), so a cleanly-completed resultless
  //    Channel turn folds to "Worked for …" instead of dumping its process inline.
  // (The old `turnEnded && !finalIsProse` conflated these: because a Channel turn
  // is always `turnPhase: idle`, it fired on every result-less turn regardless of
  // outcome — the recurring Channel mislabel.)
  const finalBlocks = visibleBlocks.slice(lastProcessIndex + 1);
  const finalProseBlocks = finalBlocks.filter(
    (block): block is Extract<(typeof visibleBlocks)[number], { type: 'text' }> => block.type === 'text',
  );
  const finalIsProse = finalProseBlocks.some((block) => block.text.trim().length > 0);
  const processSettled = finalIsProse && !turnActive;
  const turnFailedWithoutProse = turnInterrupted && !finalIsProse;
  const surfaceResultlessProcess = !finalIsProse && (turnInterrupted || (!isChannel && !turnActive));

  if (lastProcessIndex >= 0 || turnActive) {
    const processEntryEnd = Math.max(0, lastProcessIndex + 1);
    const segmentId = `process:${contentKey}`;

    const segmentFromBlock = (
      candidate: (typeof visibleBlocks)[number],
      sourceIndex: number,
    ): AgentProcessSegmentBlock => {
      const hasLater = sourceIndex < visibleBlocks.length - 1;
      if (candidate.type === 'thinking') {
        return { kind: 'thinking', sourceIndex, streaming: streaming && !hasLater, text: candidate.thinking };
      }
      if (candidate.type === 'toolCall') {
        return {
          kind: 'toolCall',
          childRun: childRunsByParentToolCallId?.get(candidate.id),
          toolCall: candidate,
          outcome: toolCallOutcomes?.get(candidate.id),
        };
      }
      return { kind: 'narration', sourceIndex, streaming: streaming && !hasLater, text: candidate.text };
    };

    const turnSegmentBlocks: AgentProcessSegmentBlock[] = visibleBlocks
      .slice(0, processEntryEnd)
      .map((block, sourceIndex) => segmentFromBlock(block, sourceIndex));

    // ONE turn-level process fold (Codex machine C). It renders the whole
    // pre-answer body — reasoning, interim narration, and the grouped
    // tool-activity — through AgentProcessTimeline (the inner per-group collapse
    // is machine B). While the turn is still WORKING it shows the body expanded
    // with a live "Working for {t}" header; the moment the final answer starts
    // (`answerStarted`) it auto-collapses to the "Worked for {t}" divider with the
    // answer streaming below.
    rendered.push(
      <AgentProcessBlock
        answerStarted={finalIsProse}
        blocks={turnSegmentBlocks}
        childRunsByParentToolCallId={childRunsByParentToolCallId}
        conversationId={conversationId}
        expandState={expandState}
        id={segmentId}
        index={documentIndex}
        key={segmentId}
        liveStartedAtMs={runStartedAtMs}
        onNodeReferenceOpen={onNodeReferenceOpen}
        onOpenChildRunTranscript={onOpenChildRunTranscript}
        pendingToolCallIds={pendingToolCallIds}
        results={toolResults}
        sealed={processSettled}
        surfaceResultlessProcess={surfaceResultlessProcess}
        turnActive={turnActive}
        turnFailedWithoutProse={turnFailedWithoutProse}
        workedForMs={workedForMs}
      />,
    );
  }

  // Trailing answer prose. `finalProseBlocks` is already narrowed to text — the
  // last process block is the fold boundary, so no thinking/tool survives past it.
  finalProseBlocks.forEach((block, i) => {
    const hasLaterText = finalProseBlocks.slice(i + 1).some((candidate) => candidate.text.trim().length > 0);
    rendered.push(
      <AgentMarkdown
        index={documentIndex}
        key={`text-${i}`}
        keyPrefix={`${contentKey}-text-${i}`}
        onNodeReferenceOpen={onNodeReferenceOpen}
        streaming={streaming && !hasLaterText}
        text={block.text}
      />,
    );
  });

  return rendered;
}
