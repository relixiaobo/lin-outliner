import type { ReactNode } from 'react';
import type { ToolCall, ToolResultMessage } from '../../../core/agentTypes';
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LoaderIcon,
} from '../icons';
import {
  AgentToolCallBlock,
  getToolCallStatus,
  summarizeToolCall,
} from './AgentToolCallBlock';

export interface AgentExpandState {
  isExpanded: (id: string, defaultExpanded?: boolean) => boolean;
  toggle: (id: string, currentlyExpanded: boolean) => void;
}

export type AgentProcessSegmentBlock =
  | {
    kind: 'thinking';
    sourceIndex: number;
    streaming: boolean;
    text: string;
  }
  | {
    kind: 'toolCall';
    toolCall: ToolCall;
  };

interface AgentProcessBlockProps {
  blocks: AgentProcessSegmentBlock[];
  expandState: AgentExpandState;
  id: string;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, ToolResultMessage>;
  sealed: boolean;
  turnActive: boolean;
  turnFailedWithoutProse: boolean;
}

function summarizeProcess({
  firstThinkingText,
  thinkingCount,
  pendingToolCallIds,
  results,
  toolCalls,
  turnActive,
  sealed,
  turnFailedWithoutProse,
}: {
  firstThinkingText: string | null;
  thinkingCount: number;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, ToolResultMessage>;
  toolCalls: ToolCall[];
  sealed: boolean;
  turnActive: boolean;
  turnFailedWithoutProse: boolean;
}): string {
  const toolCount = toolCalls.length;

  if (turnActive && !sealed) return 'Working...';

  if (turnFailedWithoutProse) {
    if (thinkingCount > 0 && toolCount > 0) return 'Interrupted after thinking';
    if (thinkingCount > 0) return 'Thought (interrupted)';
    return 'Interrupted';
  }

  if (thinkingCount === 0 && toolCount === 1) {
    const toolCall = toolCalls[0]!;
    const status = getToolCallStatus(toolCall.id, results.get(toolCall.id), pendingToolCallIds, turnActive);
    return summarizeToolCall(toolCall, status);
  }

  if (thinkingCount === 0 && toolCount >= 2) return `Used ${toolCount} tools`;

  if (thinkingCount === 1 && toolCount === 0) {
    return firstThinkingText ? `Thought · ${previewText(firstThinkingText, 80)}` : 'Thought';
  }

  if (thinkingCount > 0 && toolCount === 0) return 'Thought';

  if (thinkingCount > 0 && toolCount === 1) {
    const toolCall = toolCalls[0]!;
    const status = getToolCallStatus(toolCall.id, results.get(toolCall.id), pendingToolCallIds, turnActive);
    return `Thought · ${summarizeToolCall(toolCall, status)}`;
  }

  if (thinkingCount > 0 && toolCount >= 2) return `Thought · used ${toolCount} tools`;

  return 'Working...';
}

function firstLine(text: string): string | null {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

function previewText(text: string, maxLength: number): string {
  const first = firstLine(text) ?? text.trim();
  return first.length > maxLength ? `${first.slice(0, maxLength)}...` : first;
}

export function AgentProcessBlock({
  blocks,
  expandState,
  id,
  pendingToolCallIds,
  results,
  sealed,
  turnActive,
  turnFailedWithoutProse,
}: AgentProcessBlockProps) {
  const thinkingBlocks = blocks.filter(
    (block): block is Extract<AgentProcessSegmentBlock, { kind: 'thinking' }> => block.kind === 'thinking',
  );
  const toolCalls = blocks
    .filter((block): block is Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }> => block.kind === 'toolCall')
    .map((block) => block.toolCall);
  const soloThinking = thinkingBlocks.length === 1 && toolCalls.length === 0;
  const firstThinkingText = firstLine(thinkingBlocks[0]?.text ?? '');
  const liveSegment = turnActive && !sealed;
  const defaultExpanded = liveSegment || turnFailedWithoutProse;
  const expanded = expandState.isExpanded(id, defaultExpanded);
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className={`agent-process-block ${turnFailedWithoutProse ? 'is-error' : ''}`}>
      <button
        aria-expanded={expanded}
        className="agent-process-toggle"
        onClick={() => expandState.toggle(id, expanded)}
        type="button"
      >
        {liveSegment ? (
          <LoaderIcon className="agent-process-spinner" size={12} />
        ) : null}
        <span className="agent-process-title">
          {summarizeProcess({
            firstThinkingText,
            thinkingCount: thinkingBlocks.length,
            pendingToolCallIds,
            results,
            toolCalls,
            turnActive,
            sealed,
            turnFailedWithoutProse,
          })}
        </span>
        <Chevron size={12} />
      </button>
      {expanded ? (
        <div className="agent-process-timeline">
          {soloThinking ? (
            <AgentThinkingBody streaming={thinkingBlocks[0]!.streaming} text={thinkingBlocks[0]!.text} />
          ) : (
            blocks.map((block) => {
              if (block.kind === 'thinking') {
                return (
                  <AgentThinkingRow
                    expandState={expandState}
                    id={`${id}:thinking:${block.sourceIndex}`}
                    key={`thinking-${block.sourceIndex}`}
                    streaming={block.streaming}
                    text={block.text}
                  />
                );
              }
              return (
                <AgentToolCallBlock
                  expanded={expandState.isExpanded(`tool:${block.toolCall.id}`, false)}
                  key={`tool-${block.toolCall.id}`}
                  onToggle={() => {
                    const toolId = `tool:${block.toolCall.id}`;
                    expandState.toggle(toolId, expandState.isExpanded(toolId, false));
                  }}
                  pendingToolCallIds={pendingToolCallIds}
                  result={results.get(block.toolCall.id)}
                  toolCall={block.toolCall}
                  turnActive={turnActive}
                />
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function AgentThinkingRow({
  expandState,
  id,
  streaming,
  text,
}: {
  expandState: AgentExpandState;
  id: string;
  streaming: boolean;
  text: string;
}) {
  const trimmed = text.trim();
  if (!trimmed) {
    if (!streaming) return null;
    return (
      <div className="agent-thinking-row">
        <AgentThinkingIcon>
          <BrainIcon size={12} />
        </AgentThinkingIcon>
        <span>Thinking...</span>
      </div>
    );
  }

  const previewMax = 96;
  const preview = previewText(trimmed, previewMax);
  const isLong = trimmed.includes('\n') || (firstLine(trimmed)?.length ?? 0) > previewMax;
  const expanded = expandState.isExpanded(id, false);

  if (!isLong) {
    return (
      <div className="agent-thinking-row">
        <AgentThinkingIcon>
          <BrainIcon size={12} />
        </AgentThinkingIcon>
        <span>{trimmed}</span>
      </div>
    );
  }

  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      aria-expanded={expanded}
      className={`agent-thinking-row is-toggle ${expanded ? 'is-expanded' : ''}`}
      onClick={() => expandState.toggle(id, expanded)}
      type="button"
    >
      <AgentThinkingIcon>
        <BrainIcon size={12} />
        <Chevron className="agent-thinking-chevron" size={12} />
      </AgentThinkingIcon>
      <span>{expanded ? trimmed : preview}</span>
    </button>
  );
}

function AgentThinkingBody({ streaming, text }: { streaming: boolean; text: string }) {
  const trimmed = text.trim();
  if (!trimmed && streaming) {
    return <span className="agent-thinking-placeholder">Thinking...</span>;
  }
  if (!trimmed) return null;
  return <pre className="agent-thinking-body">{trimmed}</pre>;
}

function AgentThinkingIcon({ children }: { children: ReactNode }) {
  return <span className="agent-thinking-icon">{children}</span>;
}
