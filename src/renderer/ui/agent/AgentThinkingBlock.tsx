import { ChevronDownIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { AgentMarkdown } from './AgentMarkdown';
import type { DocumentIndex } from '../../state/document';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import type { AgentExpandState } from './agentProcessTypes';
import { useT } from '../../i18n/I18nProvider';

interface AgentReasoningProps {
  defaultExpanded?: boolean;
  expandState: AgentExpandState;
  id: string;
  index?: DocumentIndex;
  keyPrefix: string;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  streaming: boolean;
  text: string;
}

// Codex `reasoning` collapses like a tool step: the model's thinking is NOT body
// prose (that is the assistant's own narration) — it folds behind a one-line
// summary, with the full text tucked inside and revealed on click. Split the
// reasoning into that summary headline + the body: a leading `**bold**` gist line
// is the headline (markers stripped, rendered emphasized like Codex); otherwise
// the first line is the headline and the rest is the body. A single-line thought
// has no body and is a plain, non-expandable label.
function splitReasoning(text: string): { headline: string; body: string; emphasized: boolean } {
  const lines = text.split('\n');
  const firstIdx = lines.findIndex((line) => line.trim().length > 0);
  if (firstIdx < 0) return { headline: '', body: '', emphasized: false };
  const firstLine = lines[firstIdx]!.trim();
  const boldMatch = /^\*\*(.+)\*\*$/.exec(firstLine);
  return {
    headline: boldMatch ? boldMatch[1]!.trim() : firstLine,
    body: lines.slice(firstIdx + 1).join('\n').trim(),
    emphasized: Boolean(boldMatch),
  };
}

export function AgentThinkingRow({
  defaultExpanded = false,
  expandState,
  id,
  index,
  keyPrefix,
  onNodeReferenceOpen,
  streaming,
  text,
}: AgentReasoningProps) {
  const t = useT();
  const trimmed = text.trim();
  if (!trimmed) {
    if (!streaming) return null;
    // Empty live reasoning stream: a static "Thinking" cue (no shimmer — that is a
    // Codex A/B experiment we do not ship).
    return <div className="agent-process-reasoning is-thinking">{t.agent.thinking.thinking}</div>;
  }
  const { headline, body, emphasized } = splitReasoning(trimmed);
  const canExpand = body.length > 0;
  const expanded = canExpand && expandState.isExpanded(id, defaultExpanded);
  return (
    <div className="agent-process-reasoning">
      <ButtonControl
        aria-expanded={canExpand ? expanded : undefined}
        className="agent-reasoning-toggle"
        disabled={!canExpand}
        onClick={(event) => {
          if (canExpand) expandState.toggle(id, expanded, event.currentTarget);
        }}
      >
        <span className={`agent-reasoning-headline${emphasized ? ' is-gist' : ''}`}>{headline}</span>
        {canExpand ? (
          <ChevronDownIcon
            aria-hidden
            className={`agent-reasoning-chevron${expanded ? ' is-expanded' : ''}`}
            size={14}
          />
        ) : null}
      </ButtonControl>
      {expanded ? (
        <div className="agent-reasoning-body">
          <AgentMarkdown
            index={index}
            keyPrefix={keyPrefix}
            onNodeReferenceOpen={onNodeReferenceOpen}
            streaming={streaming}
            text={body}
          />
        </div>
      ) : null}
    </div>
  );
}

// A lone thought (the whole turn process is a single reasoning block) opens by
// default — there is nothing else to read, so the body shows without a click.
export function AgentThinkingBody(props: AgentReasoningProps) {
  return <AgentThinkingRow {...props} defaultExpanded />;
}
