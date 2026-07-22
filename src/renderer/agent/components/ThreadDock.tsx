import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Thread, ThreadUserContent, Turn } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { threadStore, useThreadStore } from '../store/threadStore';
import {
  AddIcon,
  ICON_SIZE,
  InfoIcon,
  ListIcon,
  MoreIcon,
  PencilIcon,
  TrashIcon,
  WarningIcon,
} from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { Button } from '../../ui/primitives/Button';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { Dialog } from '../../ui/primitives/Dialog';
import { Input } from '../../ui/primitives/Input';
import { ResizeHandle } from '../../ui/primitives/ResizeHandle';
import { ThreadList } from './ThreadList';
import { ThreadDetailsDialog } from './ThreadDetailsDialog';
import { ThreadView } from './ThreadView';
import { UserInputRequest } from './UserInputRequest';
import { turnUserContent } from '../threadInput';

export type ThreadRailState = 'collapsed' | 'open';

interface ThreadDockProps {
  readonly railState: ThreadRailState;
  readonly onOpenNodeReference: (nodeId: string) => void;
  readonly onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onResizeReset: () => void;
  readonly onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function ThreadDock({
  railState,
  onOpenNodeReference,
  onResizeKeyDown,
  onResizeReset,
  onResizeStart,
}: ThreadDockProps) {
  const t = useT();
  const snapshot = useThreadStore();
  const [listOpen, setListOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Thread | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Thread | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const renameTitleId = useId();
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const open = railState === 'open';
  const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId) ?? null;
  const turns = thread ? snapshot.turnsByThread.get(thread.id) ?? [] : [];
  const goal = thread ? snapshot.goalsByThread.get(thread.id) ?? null : null;
  const userInput = thread ? snapshot.userInputByThread.get(thread.id) ?? null : null;

  useEffect(() => {
    void threadStore.initialize();
    return () => threadStore.dispose();
  }, []);

  const title = useMemo(() => thread?.name || thread?.preview || t.agent.thread.untitled, [t, thread]);

  async function createThread() {
    if (creating) return;
    setCreating(true);
    setActionError(null);
    try {
      await threadStore.createThread();
      setListOpen(false);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  function beginRename(target: Thread) {
    setRenameTarget(target);
    setRenameDraft(target.name ?? target.preview);
  }

  async function commitRename() {
    if (!renameTarget) return;
    const target = renameTarget;
    setRenameTarget(null);
    await runAction(() => threadStore.renameThread(target.id, renameDraft.trim() || null));
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    await runAction(() => threadStore.deleteThread(target.id));
  }

  async function runAction(action: () => Promise<void>) {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function regenerate(turn: Turn) {
    if (!thread) return;
    const content = turnUserContent(turn);
    if (content.length === 0) return;
    await threadStore.forkAndSend(thread.id, turn.id, 'beforeTurn', content);
  }

  return (
    <aside
      aria-label={t.shell.agentDock.ariaLabel}
      className={`agent-dock agent-dock-${railState}`}
      data-rail-state={railState}
      inert={open ? undefined : true}
    >
      <div className="thread-dock">
        <header className="thread-dock-header">
          <IconButton icon={ListIcon} label={t.agent.thread.list} onClick={() => setListOpen(true)} variant="panel" />
          <div className="thread-dock-title">
            <strong>{thread ? title : t.agent.thread.title}</strong>
            {thread?.status.type === 'active' ? <small>{t.agent.thread.working}</small> : null}
            {thread?.status.type === 'systemError' ? <small>{t.agent.thread.systemError}</small> : null}
          </div>
          <IconButton disabled={creating} icon={AddIcon} label={t.agent.thread.new} onClick={() => void createThread()} variant="panel" />
          {thread ? (
            <div className="thread-header-actions">
              <IconButton icon={MoreIcon} label={t.agent.thread.actions} variant="panel" />
              <div className="thread-header-menu">
                <button onClick={() => setDetailsOpen(true)} type="button"><InfoIcon size={ICON_SIZE.menu} />{t.agent.thread.details}</button>
                <button onClick={() => beginRename(thread)} type="button"><PencilIcon size={ICON_SIZE.menu} />{t.agent.thread.rename}</button>
                <button onClick={() => setDeleteTarget(thread)} type="button"><TrashIcon size={ICON_SIZE.menu} />{t.agent.thread.delete}</button>
              </div>
            </div>
          ) : null}
        </header>
        {actionError || snapshot.error ? (
          <div className="thread-dock-error" role="alert">
            <WarningIcon size={ICON_SIZE.menu} />
            <span>{actionError ?? snapshot.error}</span>
          </div>
        ) : null}
        {snapshot.loading ? <p className="thread-empty-copy">{t.agent.thread.loading}</p> : null}
        {!snapshot.loading && !thread ? (
          <div className="thread-empty-state">
            <p>{t.agent.thread.empty}</p>
            <button className="button button-primary" disabled={creating} onClick={() => void createThread()} type="button">
              <AddIcon size={ICON_SIZE.menu} />
              {t.agent.thread.new}
            </button>
          </div>
        ) : null}
        {thread ? (
          <>
            <ThreadView
              goal={goal}
              onEditUserMessage={(turn, content: readonly ThreadUserContent[]) => (
                threadStore.forkAndSend(thread.id, turn.id, 'beforeTurn', content).then(() => undefined)
              )}
              onFork={(turn, kind) => threadStore.fork(thread.id, turn.id, kind).then(() => undefined)}
              onInterrupt={() => threadStore.interrupt(thread.id)}
              onOpenNodeReference={onOpenNodeReference}
              onRegenerate={regenerate}
              onSend={(content) => threadStore.send(content)}
              thread={thread}
              turns={turns}
              waitingForInput={Boolean(userInput)}
            />
            {userInput ? (
              <UserInputRequest
                onSubmit={(answers) => threadStore.respondToUserInput(userInput, answers)}
                request={userInput}
              />
            ) : null}
          </>
        ) : null}
        {listOpen ? (
          <ThreadList
            onClose={() => setListOpen(false)}
            onDelete={setDeleteTarget}
            onRename={beginRename}
            onSelect={(threadId) => {
              void runAction(() => threadStore.selectThread(threadId));
              setListOpen(false);
            }}
            selectedThreadId={snapshot.selectedThreadId}
            threads={snapshot.threads}
          />
        ) : null}
      </div>
      {renameTarget ? (
        <Dialog
          backdropClassName="confirm-dialog-backdrop"
          labelledBy={renameTitleId}
          surfaceClassName="confirm-dialog"
          initialFocus={() => renameInputRef.current}
          onBackdropMouseDown={() => setRenameTarget(null)}
          onEscapeKeyDown={() => setRenameTarget(null)}
        >
          <h2 className="confirm-dialog-title" id={renameTitleId}>{t.agent.thread.rename}</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void commitRename();
            }}
          >
            <Input
              autoComplete="off"
              className="thread-rename-input"
              label={t.agent.thread.rename}
              onChange={(event) => setRenameDraft(event.target.value)}
              ref={renameInputRef}
              value={renameDraft}
            />
            <div className="confirm-dialog-actions">
              <Button onClick={() => setRenameTarget(null)} variant="ghost">{t.agent.message.cancel}</Button>
              <Button type="submit" variant="primary">{t.agent.message.save}</Button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {detailsOpen && thread ? (
        <ThreadDetailsDialog onClose={() => setDetailsOpen(false)} thread={thread} turns={turns} />
      ) : null}
      {deleteTarget ? (
        <ConfirmDialog
          cancelLabel={t.agent.message.cancel}
          confirmLabel={t.agent.thread.delete}
          danger
          message={t.agent.thread.deleteConfirm({
            name: deleteTarget.name || deleteTarget.preview || t.agent.thread.untitled,
          })}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
          title={t.agent.thread.delete}
        />
      ) : null}
      <ResizeHandle
        className="dock-resize-handle agent-resize-handle"
        disabled={!open}
        label={t.shell.agentDock.resizeLabel}
        onDoubleClick={onResizeReset}
        onKeyDown={onResizeKeyDown}
        onPointerDown={onResizeStart}
        title={t.shell.agentDock.resizeTitle}
      />
    </aside>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
