import { BrainIcon, ICON_SIZE } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { AgentDisclosureIndicator } from './AgentDisclosureIndicator';
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
        <AgentDisclosureIndicator
          className="agent-thinking-icon"
          expanded={false}
          icon={<BrainIcon size={ICON_SIZE.rowGlyph} />}
          interactive={false}
        />
        <span className="agent-thinking-text">Thinking...</span>
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
        <AgentDisclosureIndicator
          className="agent-thinking-icon"
          expanded={false}
          icon={<BrainIcon size={ICON_SIZE.rowGlyph} />}
          interactive={false}
        />
        <span className="agent-thinking-text">{trimmed}</span>
      </div>
    );
  }

  return (
    <ButtonControl
      aria-expanded={expanded}
      className={`agent-thinking-row is-toggle ${expanded ? 'is-expanded' : ''}`}
      onClick={() => expandState.toggle(id, expanded)}
    >
      <AgentDisclosureIndicator
        className="agent-thinking-icon"
        expanded={expanded}
        icon={<BrainIcon size={ICON_SIZE.rowGlyph} />}
      />
      <span className="agent-thinking-text">{expanded ? trimmed : preview}</span>
    </ButtonControl>
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
