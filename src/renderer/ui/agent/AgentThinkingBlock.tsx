import type { ReactNode } from 'react';
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '../icons';
import type { AgentExpandState } from './agentProcessTypes';
import { firstLine, previewText } from './agentProcessTypes';

interface AgentThinkingRowProps {
  expandState: AgentExpandState;
  id: string;
  streaming: boolean;
  text: string;
}

export function AgentThinkingRow({
  expandState,
  id,
  streaming,
  text,
}: AgentThinkingRowProps) {
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

export function AgentThinkingBody({ streaming, text }: { streaming: boolean; text: string }) {
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
