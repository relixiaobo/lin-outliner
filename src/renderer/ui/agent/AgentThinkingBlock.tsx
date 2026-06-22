import { ChevronRightIcon } from '../icons';
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

// Codex `reasoning` (reasoning-minimal `Xw`) collapses like a tool step: the
// model's thinking is NOT body prose (that is the assistant's own narration) — it
// folds behind a one-line headline, with the full text tucked inside and revealed
// on click. The headline is a fixed LIFECYCLE label — "Thinking" while the thought
// streams, "Thought" once the turn settles — never the thought's own first line
// (the ratified 折中: Codex's uniform label, but without per-item "Thought for {t}"
// timing, which our projection does not track). While streaming the body shows so
// the user watches the reasoning 1:1; once sealed it rests folded.
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
    // Empty live reasoning stream: the bare "Thinking" cue (no shimmer — that is a
    // Codex A/B experiment we do not ship).
    return <div className="agent-process-reasoning is-thinking">{t.agent.thinking.thinking}</div>;
  }
  const headline = streaming ? t.agent.thinking.thinking : t.agent.thinking.thought;
  // Live reasoning opens so the thought streams in view; a sealed row rests folded
  // unless it is the lone process block (`defaultExpanded`), where there is nothing
  // else to read.
  const expanded = expandState.isExpanded(id, defaultExpanded || streaming);
  return (
    <div className="agent-process-reasoning">
      <ButtonControl
        aria-expanded={expanded}
        className="agent-reasoning-toggle"
        onClick={(event) => expandState.toggle(id, expanded, event.currentTarget)}
      >
        <span className="agent-reasoning-headline" title={headline}>
          {headline}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={`agent-reasoning-chevron${expanded ? ' is-expanded' : ''}`}
          size={14}
        />
      </ButtonControl>
      {expanded ? (
        <div className="agent-reasoning-body">
          <AgentMarkdown
            index={index}
            keyPrefix={keyPrefix}
            onNodeReferenceOpen={onNodeReferenceOpen}
            streaming={streaming}
            text={trimmed}
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
