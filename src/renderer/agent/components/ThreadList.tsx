import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Thread, ThreadId } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, ICON_SIZE, InfoIcon, MoreIcon, PencilIcon, TrashIcon } from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { useAnchoredOverlay } from '../../ui/primitives/useAnchoredOverlay';
import { useMenuKeyboard } from '../../ui/primitives/useMenuKeyboard';

interface ThreadListProps {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly threads: readonly Thread[];
  readonly selectedThreadId: ThreadId | null;
  readonly createDisabled: boolean;
  readonly createTitle: string;
  readonly onClose: () => void;
  readonly onCreate: () => void;
  readonly onDelete: (thread: Thread) => void;
  readonly onDetails: (thread: Thread) => void;
  readonly onRename: (thread: Thread) => void;
  readonly onSelect: (threadId: ThreadId) => void;
}

export function ThreadList({
  anchorRef,
  createDisabled,
  createTitle,
  threads,
  selectedThreadId,
  onClose,
  onCreate,
  onDelete,
  onDetails,
  onRename,
  onSelect,
}: ThreadListProps) {
  const t = useT();
  const listRef = useRef<HTMLElement>(null);
  const actionsAnchorRef = useRef<HTMLButtonElement | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const [actionsTarget, setActionsTarget] = useState<Thread | null>(null);
  const style = useAnchoredOverlay(listRef, {
    anchorRef,
    layoutKey: `${threads.length}:${selectedThreadId ?? ''}`,
    maxHeight: 420,
    placement: 'bottom-start',
    width: 326,
  });
  const { onKeyDown } = useMenuKeyboard({
    active: true,
    getRestoreTarget: () => anchorRef.current,
    initialFocus: 'surface',
    kind: 'dialog',
    onClose,
    surfaceRef: listRef,
  });
  const actionsStyle = useAnchoredOverlay(actionsMenuRef, {
    anchorRef: actionsAnchorRef,
    disabled: actionsTarget === null,
    layoutKey: actionsTarget?.id ?? '',
    placement: 'bottom-end',
    width: 168,
  });
  const { onKeyDown: onActionsKeyDown } = useMenuKeyboard({
    active: actionsTarget !== null,
    getRestoreTarget: () => actionsAnchorRef.current,
    kind: 'menu',
    onClose: () => setActionsTarget(null),
    surfaceRef: actionsMenuRef,
  });

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        listRef.current?.contains(target)
        || actionsMenuRef.current?.contains(target)
        || anchorRef.current?.contains(target)
      ) return;
      onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [anchorRef, onClose]);

  const runThreadAction = (action: (thread: Thread) => void) => {
    const target = actionsTarget;
    if (!target) return;
    setActionsTarget(null);
    onClose();
    action(target);
  };

  return createPortal(
    <section
      className="thread-list"
      aria-label={t.agent.thread.title}
      onKeyDown={onKeyDown}
      ref={listRef}
      role="dialog"
      style={style as CSSProperties}
    >
      <header>
        <h2>{t.agent.thread.title}</h2>
        <IconButton
          disabled={createDisabled}
          icon={AddIcon}
          label={t.agent.thread.new}
          onClick={onCreate}
          title={createTitle}
          variant="message"
        />
      </header>
      <div className="thread-list-scroll">
        {threads.length === 0 ? <p className="thread-empty-copy">{t.agent.thread.noThreads}</p> : null}
        {threads.map((thread) => {
          const selected = thread.id === selectedThreadId;
          const identity = threadIdentity(thread, t.agent.thread.sources);
          return (
            <div
              className={`thread-list-row${selected ? ' is-selected' : ''}`}
              key={thread.id}
              style={{ '--thread-depth': lineageDepth(thread, threads) } as React.CSSProperties}
            >
              <button className="thread-list-select" onClick={() => onSelect(thread.id)} type="button">
                <span>{thread.name || thread.preview || t.agent.thread.untitled}</span>
                <small>
                  {identity ? <>{identity}{' · '}</> : null}
                  {formatRelativeTime(thread.updatedAt)}
                </small>
              </button>
              <span className="thread-list-actions">
                <IconButton
                  aria-expanded={actionsTarget?.id === thread.id}
                  icon={MoreIcon}
                  iconSize={ICON_SIZE.tiny}
                  label={t.agent.thread.actions}
                  onClick={(event) => {
                    actionsAnchorRef.current = event.currentTarget;
                    setActionsTarget((current) => current?.id === thread.id ? null : thread);
                  }}
                  variant="message"
                />
              </span>
            </div>
          );
        })}
      </div>
      {actionsTarget ? createPortal(
        <div
          aria-label={t.agent.thread.actions}
          className="thread-action-menu"
          onKeyDown={(event) => {
            event.stopPropagation();
            onActionsKeyDown(event);
          }}
          ref={actionsMenuRef}
          role="menu"
          style={actionsStyle}
        >
          <button onClick={() => runThreadAction(onDetails)} role="menuitem" type="button">
            <InfoIcon size={ICON_SIZE.menu} />{t.agent.thread.details}
          </button>
          <button onClick={() => runThreadAction(onRename)} role="menuitem" type="button">
            <PencilIcon size={ICON_SIZE.menu} />{t.agent.thread.rename}
          </button>
          <button onClick={() => runThreadAction(onDelete)} role="menuitem" type="button">
            <TrashIcon size={ICON_SIZE.menu} />{t.agent.thread.delete}
          </button>
        </div>,
        document.body,
      ) : null}
    </section>,
    document.body,
  );
}

function threadIdentity(
  thread: Thread,
  labels: { readonly subagent: string; readonly memory: string; readonly automation: string; readonly feature: string },
): string | null {
  const agent = thread.agentNickname && thread.agentRole
    ? `${thread.agentNickname} [${thread.agentRole}]`
    : thread.agentNickname ?? thread.agentRole;
  const source = thread.threadSource === 'user'
    ? null
    : thread.threadSource === 'subagent'
      ? labels.subagent
      : thread.threadSource === 'memory_consolidation'
        ? labels.memory
        : thread.threadSource === 'automation'
          ? labels.automation
          : labels.feature;
  if (!source) return agent;
  return agent ? `${source} · ${agent}` : source;
}

function lineageDepth(thread: Thread, threads: readonly Thread[]): number {
  const byId = new Map(threads.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  let current = thread;
  let depth = 0;
  while (current.parentThreadId) {
    const parentId = current.parentThreadId;
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
