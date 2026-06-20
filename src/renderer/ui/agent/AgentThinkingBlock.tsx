import type { DocumentIndex } from '../../state/document';
import { AgentMarkdown } from './AgentMarkdown';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { useT } from '../../i18n/I18nProvider';

interface AgentReasoningProps {
  index?: DocumentIndex;
  keyPrefix: string;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  streaming: boolean;
  text: string;
}

// Codex renders reasoning as the SAME body prose as the final answer — it is just
// the part of the turn collapsed behind the "Worked for {t}" fold (machine C). So
// reasoning is full body-register markdown here, NOT a dim meta gist row: no
// lightbulb, no per-block toggle, shown in full whenever the turn process is
// expanded. A `**bold**` gist headline therefore renders as a real markdown
// heading rather than being stripped. The only special state is an empty live
// reasoning stream, which shows a static "Thinking" cue (no shimmer — the
// cadenced shimmer is a Codex A/B experiment we do not ship).
export function AgentThinkingRow({
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
    return <div className="agent-process-reasoning is-thinking">{t.agent.thinking.thinking}</div>;
  }
  return (
    <div className="agent-process-reasoning">
      <AgentMarkdown
        index={index}
        keyPrefix={keyPrefix}
        onNodeReferenceOpen={onNodeReferenceOpen}
        streaming={streaming}
        text={trimmed}
      />
    </div>
  );
}

// A lone thought (the whole turn process is a single reasoning block) renders the
// same body prose, always open — one register, no special-casing.
export function AgentThinkingBody(props: AgentReasoningProps) {
  return <AgentThinkingRow {...props} />;
}
