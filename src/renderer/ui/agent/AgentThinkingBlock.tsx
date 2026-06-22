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

// The first non-empty line of the reasoning, stripped of markdown emphasis/heading
// markers, as a dim one-line preview beside the "Thought" label. A turn can produce
// many reasoning bursts; a column of bare "Thought" labels is indistinguishable, so
// the gist keeps them readable. The full thinking stays the expandable body.
function reasoningGist(text: string): string {
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return firstLine
    .replace(/^#+\s*/, '')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Codex `reasoning` (reasoning-minimal `Xw`) collapses like a tool step: the
// model's thinking is NOT body prose (that is the assistant's own narration) — it
// folds behind a one-line row, the full text revealed on click. The leading label
// is a fixed LIFECYCLE word — "Thinking" while the thought streams, "Thought" once
// the turn settles — never the thought's own first line as the headline (the
// ratified 折中: no per-item "Thought for {t}" timing, which our projection does not
// track). Collapsed, a dim one-line gist of the first line trails the label so a
// stack of reasoning rows stays distinguishable; expanded (and while streaming) the
// full thinking shows as the body.
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
  const label = streaming ? t.agent.thinking.thinking : t.agent.thinking.thought;
  // Live reasoning opens so the thought streams in view; a sealed row rests folded
  // unless it is the lone process block (`defaultExpanded`), where there is nothing
  // else to read.
  const expanded = expandState.isExpanded(id, defaultExpanded || streaming);
  // The gist only rides the collapsed row — expanded, the full first line is already
  // the top of the body, so an inline copy would just duplicate it.
  const gist = expanded ? '' : reasoningGist(trimmed);
  return (
    <div className="agent-process-reasoning">
      <ButtonControl
        aria-expanded={expanded}
        className="agent-reasoning-toggle"
        onClick={(event) => expandState.toggle(id, expanded, event.currentTarget)}
      >
        <span className="agent-reasoning-headline">{label}</span>
        {gist ? (
          <span className="agent-reasoning-gist" title={gist}>· {gist}</span>
        ) : null}
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
