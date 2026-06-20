import { ThinkingIcon, ICON_SIZE } from '../icons';
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

// Codex reasoning items often lead with a `**bold**` one-line gist headline (`Xw`
// strips the markers). Drop the surrounding `**` so the gist reads as the clean
// preview line, keeping the rest of the reasoning as the body.
function reasoningText(text: string): string {
  const lines = text.split('\n');
  const firstIdx = lines.findIndex((line) => line.trim().length > 0);
  if (firstIdx >= 0) {
    const match = /^\*\*(.+)\*\*$/.exec(lines[firstIdx]!.trim());
    if (match) {
      lines[firstIdx] = lines[firstIdx]!.replace(/^(\s*)\*\*(.+)\*\*(\s*)$/, `$1${match[1]!.trim()}$3`);
    }
  }
  return lines.join('\n').trim();
}

export function AgentThinkingRow({
  expandState,
  id,
  streaming,
  text,
}: AgentThinkingRowProps) {
  const t = useT();
  const trimmed = reasoningText(text);
  if (!trimmed) {
    if (!streaming) return null;
    return (
      <div className="agent-thinking-row">
        <AgentDisclosureIndicator
          className="agent-thinking-icon"
          expanded={false}
          icon={<ThinkingIcon size={ICON_SIZE.rowGlyph} />}
          interactive={false}
        />
        {/* Reasoning lifecycle (Codex `Xw`): a STATIC "Thinking" cue (no ellipsis,
            no shimmer — the shimmer is a Codex A/B experiment). */}
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
          icon={<ThinkingIcon size={ICON_SIZE.rowGlyph} />}
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
      onClick={(event) => expandState.toggle(id, expanded, event.currentTarget)}
    >
      <AgentDisclosureIndicator
        className="agent-thinking-icon"
        expanded={expanded}
        icon={<ThinkingIcon size={ICON_SIZE.rowGlyph} />}
      />
      <span className="agent-thinking-text">{expanded ? trimmed : preview}</span>
    </ButtonControl>
  );
}

export function AgentThinkingBody({ streaming, text }: { streaming: boolean; text: string }) {
  const t = useT();
  const trimmed = reasoningText(text);
  if (!trimmed && streaming) {
    return <span className="agent-thinking-placeholder">{t.agent.thinking.thinking}</span>;
  }
  if (!trimmed) return null;
  return <pre className="agent-thinking-body">{trimmed}</pre>;
}
