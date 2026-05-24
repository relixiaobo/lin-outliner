import { useState } from 'react';
import type { AgentCompactionEntry } from '../../agent/runtime';
import {
  ChevronDownIcon,
  ICON_SIZE,
  LoaderIcon,
} from '../icons';
import { AgentMarkdown } from './AgentMarkdown';

function compactTriggerLabel(trigger: AgentCompactionEntry['compaction']['trigger']): string {
  if (trigger === 'manual') return 'Manual';
  if (trigger === 'auto') return 'Auto';
  return 'Retry';
}

export function AgentCompactionBoundary({
  entry,
}: {
  entry: AgentCompactionEntry;
}) {
  const [expanded, setExpanded] = useState(false);
  const isActive = entry.status === 'active';
  const summary = entry.status === 'completed' ? entry.compaction.summary.trim() : '';
  const showSummary = expanded && summary.length > 0;

  return (
    <section className="agent-compaction-boundary" aria-label={isActive ? 'Compacting conversation' : 'Conversation compacted'}>
      <div className="agent-compaction-line" aria-hidden="true" />
      <div className="agent-compaction-controls">
        {isActive ? (
          <div className="agent-compaction-toggle is-active" role="status">
            <LoaderIcon className="agent-tool-call-spinner" size={ICON_SIZE.tiny} />
            <span>Compacting</span>
            <small>{compactTriggerLabel(entry.compaction.trigger)}</small>
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
            <span>Compacted</span>
            <small>{compactTriggerLabel(entry.compaction.trigger)}</small>
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
