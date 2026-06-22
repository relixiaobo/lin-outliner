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
// the first line is the headline and the rest is the body. A SHORT single-line
// thought has no body and renders as a plain, inert label; a LONG single line
// keeps itself as the body so it stays expandable rather than clipped forever.

// A single-line thought longer than this is clipped by the one-line summary, so
// it keeps the full text as expandable body rather than an unreadable ellipsis.
const REASONING_PREVIEW_MAX = 96;

function splitReasoning(text: string): { headline: string; body: string; emphasized: boolean } {
  const lines = text.split('\n');
  const firstIdx = lines.findIndex((line) => line.trim().length > 0);
  if (firstIdx < 0) return { headline: '', body: '', emphasized: false };
  const firstLine = lines[firstIdx]!.trim();
  const rest = lines.slice(firstIdx + 1).join('\n').trim();
  // A leading **bold** gist becomes the emphasized headline (Codex §5). Match the
  // leading bold even when text follows it on the line, so `**Step 1** review the
  // diff` doesn't leak literal `**`; the remainder flows into the body.
  const lead = /^\*\*(.+?)\*\*\s*/.exec(firstLine);
  if (lead) {
    const headline = lead[1]!.trim();
    const tail = firstLine.slice(lead[0].length).trim();
    return { headline, body: [tail, rest].filter(Boolean).join('\n\n'), emphasized: true };
  }
  // A plain first line with no following body is a label — but if it is long
  // enough to be clipped by the one-line summary, keep the full line as the body
  // so the rest stays readable (expandable) instead of lost behind an ellipsis.
  if (!rest && firstLine.length > REASONING_PREVIEW_MAX) {
    return { headline: firstLine, body: firstLine, emphasized: false };
  }
  return { headline: firstLine, body: rest, emphasized: false };
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
  const headlineSpan = (
    <span className={`agent-reasoning-headline${emphasized ? ' is-gist' : ''}`} title={headline}>
      {headline}
    </span>
  );
  return (
    <div className="agent-process-reasoning">
      {canExpand ? (
        <ButtonControl
          aria-expanded={expanded}
          className="agent-reasoning-toggle"
          onClick={(event) => expandState.toggle(id, expanded, event.currentTarget)}
        >
          {headlineSpan}
          <ChevronDownIcon
            aria-hidden
            className={`agent-reasoning-chevron${expanded ? ' is-expanded' : ''}`}
            size={14}
          />
        </ButtonControl>
      ) : (
        // A single-line thought with nothing to reveal is read-only text, not a
        // disabled button — a disabled button leaves the tab order and is
        // announced as a dimmed control for purely informational content.
        <div className="agent-reasoning-toggle is-static">{headlineSpan}</div>
      )}
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
