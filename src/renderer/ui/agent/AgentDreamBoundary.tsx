import { useState } from 'react';
import type { AgentDreamEntry } from '../../agent/runtime';
import {
  BrainIcon,
  ChevronDownIcon,
  ICON_SIZE,
  LoaderIcon,
  WarningIcon,
} from '../icons';
import { useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';

function dreamTriggerLabel(
  trigger: AgentDreamEntry['dream']['trigger'],
  labels: Messages['agent']['process']['dreamTrigger'],
): string {
  return trigger === 'schedule' ? labels.schedule : labels.manual;
}

function totalMemoryChanges(changes: Extract<AgentDreamEntry, { status: 'completed' }>['dream']['changes']): number {
  return changes ? changes.added + changes.updated + changes.forgotten : 0;
}

function dreamStatusLabel(
  entry: AgentDreamEntry,
  labels: Messages['agent']['process'],
): string {
  if (entry.status === 'active') return labels.dreaming;
  if (entry.dream.status === 'failed') return labels.dreamFailed;
  if (entry.dream.status === 'skipped') return labels.dreamSkipped;
  return labels.dreamed;
}

function dreamMeta(entry: AgentDreamEntry, labels: Messages['agent']['process']): string {
  if (entry.status === 'active') return dreamTriggerLabel(entry.dream.trigger, labels.dreamTrigger);
  const parts = [dreamTriggerLabel(entry.dream.trigger, labels.dreamTrigger)];
  if (entry.dream.processed) {
    parts.push(labels.dreamProcessedMessages({ count: entry.dream.processed.totalMessageCount }));
  }
  if (entry.dream.changes) {
    parts.push(labels.dreamMemoryChanges({ count: totalMemoryChanges(entry.dream.changes) }));
  }
  return parts.join(' · ');
}

export function AgentDreamBoundary({
  entry,
}: {
  entry: AgentDreamEntry;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const isActive = entry.status === 'active';
  const hasDetails = entry.status === 'completed'
    && (entry.dream.processed || entry.dream.changes || entry.dream.errorMessage);
  const showDetails = expanded && entry.status === 'completed' && hasDetails;
  const statusLabel = dreamStatusLabel(entry, t.agent.process);
  const meta = dreamMeta(entry, t.agent.process);

  return (
    <section className="agent-compaction-boundary agent-dream-boundary" aria-label={isActive ? t.agent.process.dreamingMemory : t.agent.process.memoryDreamed}>
      <div className="agent-compaction-line" aria-hidden="true" />
      <div className="agent-compaction-controls">
        {isActive ? (
          <div className="agent-compaction-toggle is-active" role="status">
            <LoaderIcon className="agent-tool-call-spinner" size={ICON_SIZE.tiny} />
            <span>{statusLabel}</span>
            <small>{meta}</small>
          </div>
        ) : (
          <button
            aria-expanded={expanded}
            className="agent-compaction-toggle"
            disabled={!hasDetails}
            onClick={() => setExpanded((open) => !open)}
            type="button"
          >
            {entry.dream.status === 'failed' ? (
              <WarningIcon size={ICON_SIZE.tiny} />
            ) : hasDetails ? (
              <ChevronDownIcon
                className={expanded ? 'agent-compaction-chevron is-expanded' : 'agent-compaction-chevron'}
                size={ICON_SIZE.tiny}
              />
            ) : (
              <BrainIcon size={ICON_SIZE.tiny} />
            )}
            <span>{statusLabel}</span>
            <small>{meta}</small>
          </button>
        )}
      </div>
      <div className="agent-compaction-line" aria-hidden="true" />
      {showDetails ? (
        <div className="agent-compaction-summary agent-dream-summary">
          {entry.dream.errorMessage ? <p>{entry.dream.errorMessage}</p> : null}
          {entry.dream.processed ? (
            <p>
              {t.agent.process.dreamProcessedDetail({
                messages: entry.dream.processed.totalMessageCount,
                chars: entry.dream.processed.totalCharCount,
              })}
            </p>
          ) : null}
          {entry.dream.changes ? (
            <p>
              {t.agent.process.dreamChangesDetail({
                added: entry.dream.changes.added,
                updated: entry.dream.changes.updated,
                forgotten: entry.dream.changes.forgotten,
                skipped: entry.dream.changes.skipped,
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
