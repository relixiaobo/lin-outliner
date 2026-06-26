import type { Messages } from '../../../core/i18n';
import type { AgentRenderDreamRunEntity } from '../../api/types';
import { LoaderIcon } from '../icons';
import { EmptyState } from '../primitives/FeedbackState';
import { InsetGroup, InsetRow } from './SettingsInsetList';

interface DreamHistoryGroupProps {
  entries: readonly AgentRenderDreamRunEntity[];
  loading: boolean;
  t: Messages;
  formatDate: (timestamp: number) => string;
}

/**
 * Dream activity surfaced in Settings → Agent (no longer in the in-conversation
 * Work panel). Read-only rows — a Dream is a record of past memory maintenance,
 * not something the user edits or forgets here. Kept as its own component so it
 * can be unit-tested without mounting the full settings view, whose provider
 * catalog pulls Vite-only brand assets.
 */
export function DreamHistoryGroup({ entries, loading, t, formatDate }: DreamHistoryGroupProps) {
  if (loading) {
    return (
      <EmptyState
        className="agent-settings-empty"
        icon={LoaderIcon}
        loading
        role="status"
        size="inline"
        title={t.settings.memory.dreamHistoryLoading}
      />
    );
  }
  if (entries.length === 0) {
    return <EmptyState className="agent-settings-empty" size="inline" title={t.settings.memory.dreamHistoryEmpty} />;
  }
  return (
    <InsetGroup ariaLabel={t.settings.memory.dreamHistoryAriaLabel} label={t.settings.memory.dreamHistoryGroup}>
      {entries.map((entry) => (
        <InsetRow
          key={entry.id}
          label={<span className="settings-memory-fact">{t.agent.run.dreamTitle}</span>}
          sublabel={(
            <span className="settings-dream-meta">
              {dreamMetaChips(entry, t, formatDate).map((part, index) => (
                <span className="settings-chip" key={index}>{part}</span>
              ))}
            </span>
          )}
          wrap
        />
      ))}
    </InsetGroup>
  );
}

export function dreamMetaChips(
  entry: AgentRenderDreamRunEntity,
  t: Messages,
  formatDate: (timestamp: number) => string,
): string[] {
  const parts: string[] = [
    entry.trigger === 'schedule' ? t.agent.run.triggerSchedule : t.agent.run.triggerManual,
    t.agent.run.status[entry.status],
  ];
  if (entry.processed) parts.push(t.agent.run.messages({ count: entry.processed.totalMessageCount }));
  if (entry.window) parts.push(t.settings.memory.dreamWindow(entry.window));
  if (entry.changes) {
    parts.push(t.agent.run.memoryChanges({
      count: entry.changes.added + entry.changes.updated + entry.changes.forgotten,
    }));
  }
  parts.push(t.settings.memory.createdAt({ date: formatDate(entry.startedAt) }));
  return parts;
}
