import type { Thread, ThreadId } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { CloseIcon, ICON_SIZE, PencilIcon, TrashIcon } from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';

interface ThreadListProps {
  readonly threads: readonly Thread[];
  readonly selectedThreadId: ThreadId | null;
  readonly onClose: () => void;
  readonly onDelete: (thread: Thread) => void;
  readonly onRename: (thread: Thread) => void;
  readonly onSelect: (threadId: ThreadId) => void;
}

export function ThreadList({
  threads,
  selectedThreadId,
  onClose,
  onDelete,
  onRename,
  onSelect,
}: ThreadListProps) {
  const t = useT();
  return (
    <section className="thread-list" aria-label={t.agent.thread.title}>
      <header>
        <h2>{t.agent.thread.title}</h2>
        <IconButton icon={CloseIcon} label={t.agent.thread.closeList} onClick={onClose} variant="panel" />
      </header>
      <div className="thread-list-scroll">
        {threads.length === 0 ? <p className="thread-empty-copy">{t.agent.thread.noThreads}</p> : null}
        {threads.map((thread) => {
          const selected = thread.id === selectedThreadId;
          return (
            <div
              className={`thread-list-row${selected ? ' is-selected' : ''}`}
              key={thread.id}
              style={{ '--thread-depth': lineageDepth(thread, threads) } as React.CSSProperties}
            >
              <button className="thread-list-select" onClick={() => onSelect(thread.id)} type="button">
                <span>{thread.name || thread.preview || t.agent.thread.untitled}</span>
                <small>
                  {thread.agentRole || thread.threadSource}
                  {' · '}
                  {formatRelativeTime(thread.updatedAt)}
                </small>
              </button>
              {selected ? (
                <span className="thread-list-actions">
                  <IconButton
                    icon={PencilIcon}
                    iconSize={ICON_SIZE.tiny}
                    label={t.agent.thread.rename}
                    onClick={() => onRename(thread)}
                    variant="message"
                  />
                  <IconButton
                    icon={TrashIcon}
                    iconSize={ICON_SIZE.tiny}
                    label={t.agent.thread.delete}
                    onClick={() => onDelete(thread)}
                    variant="message"
                  />
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function lineageDepth(thread: Thread, threads: readonly Thread[]): number {
  const byId = new Map(threads.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  let current = thread;
  let depth = 0;
  while (current.parentThreadId || current.forkedFromId) {
    const parentId = current.parentThreadId ?? current.forkedFromId;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return Math.min(depth, 3);
}

function formatRelativeTime(timestamp: number): string {
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(elapsedSeconds) < 60) return formatter.format(elapsedSeconds, 'second');
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(elapsedMinutes) < 60) return formatter.format(elapsedMinutes, 'minute');
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) return formatter.format(elapsedHours, 'hour');
  return formatter.format(Math.round(elapsedHours / 24), 'day');
}
