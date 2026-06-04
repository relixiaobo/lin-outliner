import { useState } from 'react';
import type { AgentCompactionEntry } from '../../agent/runtime';
import {
  ChevronDownIcon,
  ICON_SIZE,
  LoaderIcon,
} from '../icons';
import { AgentMarkdown } from './AgentMarkdown';
import { useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';

function compactTriggerLabel(
  trigger: AgentCompactionEntry['compaction']['trigger'],
  labels: Messages['agent']['process']['compactionTrigger'],
): string {
  if (trigger === 'manual') return labels.manual;
  if (trigger === 'auto') return labels.auto;
  return labels.retry;
}

export function AgentCompactionBoundary({
  entry,
}: {
  entry: AgentCompactionEntry;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const isActive = entry.status === 'active';
  const summary = entry.status === 'completed' ? entry.compaction.summary.trim() : '';
  const showSummary = expanded && summary.length > 0;

  return (
    <section className="agent-compaction-boundary" aria-label={isActive ? t.agent.process.compactingConversation : t.agent.process.conversationCompacted}>
      <div className="agent-compaction-line" aria-hidden="true" />
      <div className="agent-compaction-controls">
        {isActive ? (
          <div className="agent-compaction-toggle is-active" role="status">
            <LoaderIcon className="agent-tool-call-spinner" size={ICON_SIZE.tiny} />
            <span>{t.agent.process.compacting}</span>
            <small>{compactTriggerLabel(entry.compaction.trigger, t.agent.process.compactionTrigger)}</small>
          </div>
        ) : (
          <button
            aria-expanded={expanded}
            className="agent-compaction-toggle"
            onClick={() => setExpanded((open) => !open)}
            type="button"
          >
            <ChevronDownIcon
              className={expanded ? 'agent-compaction-chevron is-expanded' : 'agent-compaction-chevron'}
              size={ICON_SIZE.tiny}
            />
            <span>{t.agent.process.compacted}</span>
            <small>{compactTriggerLabel(entry.compaction.trigger, t.agent.process.compactionTrigger)}</small>
          </button>
        )}
      </div>
      <div className="agent-compaction-line" aria-hidden="true" />
      {showSummary ? (
        <div className="agent-compaction-summary">
          <AgentMarkdown keyPrefix={`compact-${entry.compaction.id}`} text={summary} />
        </div>
      ) : null}
    </section>
  );
}
