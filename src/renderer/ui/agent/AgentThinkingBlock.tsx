import { BrainIcon, ICON_SIZE } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { AgentDisclosureIndicator } from './AgentDisclosureIndicator';
import type { AgentExpandState } from './agentProcessTypes';
import { firstLine, previewText } from './agentProcessTypes';
import { useT } from '../../i18n/I18nProvider';

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
  const t = useT();
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
        <span className="agent-thinking-text">{t.agent.thinking.thinking}</span>
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
  const t = useT();
  const trimmed = text.trim();
  if (!trimmed && streaming) {
    return <span className="agent-thinking-placeholder">{t.agent.thinking.thinking}</span>;
  }
  if (!trimmed) return null;
  return <pre className="agent-thinking-body">{trimmed}</pre>;
}
