import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Thread, ThreadUserContent, Turn } from '../../../core/agent/protocol';
import type { AgentProviderSettingsView, AgentSlashCommandView, SkillDefinition } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { threadStore, useThreadStore } from '../store/threadStore';
import {
  AddIcon,
  ChevronDownIcon,
  HashIcon,
  ICON_SIZE,
  InfoIcon,
  MoreIcon,
  PencilIcon,
  SettingsIcon,
  TrashIcon,
  WarningIcon,
} from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { Button } from '../../ui/primitives/Button';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { Dialog } from '../../ui/primitives/Dialog';
import { Input } from '../../ui/primitives/Input';
import { ResizeHandle } from '../../ui/primitives/ResizeHandle';
import { useAnchoredOverlay } from '../../ui/primitives/useAnchoredOverlay';
import { useMenuKeyboard } from '../../ui/primitives/useMenuKeyboard';
import { ThreadList } from './ThreadList';
import { ThreadDetailsDialog } from './ThreadDetailsDialog';
import { ThreadView } from './ThreadView';
import { turnUserContent } from '../threadInput';
import { resolveUsableActiveProvider } from '../../ui/agent/providerUsability';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';

export type ThreadRailState = 'collapsed' | 'open';

interface ThreadDockProps {
  readonly index: DocumentIndex;
  readonly railState: ThreadRailState;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onResizeReset: () => void;
  readonly onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function ThreadDock({
  index,
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
  const [providerSettings, setProviderSettings] = useState<AgentProviderSettingsView | null>(null);
  const [providerSettingsLoaded, setProviderSettingsLoaded] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const [slashCommands, setSlashCommands] = useState<AgentSlashCommandView[]>([]);
  const [actionsOpen, setActionsOpen] = useState(false);
  const renameTitleId = useId();
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const threadListAnchorRef = useRef<HTMLButtonElement | null>(null);
  const actionsAnchorRef = useRef<HTMLButtonElement | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const providerSettingsRequestRef = useRef(0);
  const slashCommandsRequestRef = useRef(0);
  const open = railState === 'open';
  const openRef = useRef(open);
  const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId) ?? null;
  const turns = thread ? snapshot.turnsByThread.get(thread.id) ?? [] : [];
  const goal = thread ? snapshot.goalsByThread.get(thread.id) ?? null : null;
  const configuration = thread ? snapshot.configurationsByThread.get(thread.id) ?? null : null;
  const userInput = thread ? snapshot.userInputByThread.get(thread.id) ?? null : null;
  const providerBlocksCreation = providerSettingsLoaded
    && (!providerSettings || !resolveUsableActiveProvider(providerSettings));
  const actionsMenuStyle = useAnchoredOverlay(actionsMenuRef, {
    anchorRef: actionsAnchorRef,
    disabled: !actionsOpen,
    layoutKey: thread?.id ?? '',
    placement: 'bottom-end',
    width: 168,
  });
  const { onKeyDown: onActionsKeyDown } = useMenuKeyboard({
    active: actionsOpen,
    getRestoreTarget: () => actionsAnchorRef.current,
    kind: 'menu',
    onClose: () => setActionsOpen(false),
    surfaceRef: actionsMenuRef,
  });

  useEffect(() => {
    if (open && !openRef.current) setComposerFocusToken((token) => token + 1);
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    setActionsOpen(false);
  }, [thread?.id]);

  useEffect(() => {
    if (!actionsOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (actionsMenuRef.current?.contains(target) || actionsAnchorRef.current?.contains(target)) return;
      setActionsOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [actionsOpen]);

  const refreshProviderSettings = useCallback(async () => {
    const request = providerSettingsRequestRef.current + 1;
    providerSettingsRequestRef.current = request;
    try {
      const settings = await api.agentGetProviderSettings();
      if (providerSettingsRequestRef.current !== request) return;
      setProviderSettings(settings);
      setProviderError(null);
    } catch (error) {
      if (providerSettingsRequestRef.current !== request) return;
      setProviderSettings(null);
      setProviderError(errorMessage(error));
    } finally {
      if (providerSettingsRequestRef.current === request) setProviderSettingsLoaded(true);
    }
  }, []);

  const refreshSlashCommands = useCallback(async () => {
    const request = slashCommandsRequestRef.current + 1;
    slashCommandsRequestRef.current = request;
    try {
      const skills = await api.agentListUserInvocableSkills();
      if (slashCommandsRequestRef.current === request) {
        setSlashCommands(slashCommandsFromSkills(skills));
      }
    } catch {
      if (slashCommandsRequestRef.current === request) setSlashCommands([]);
    }
  }, []);

  useEffect(() => {
    void threadStore.initialize();
    void refreshProviderSettings();
    void refreshSlashCommands();
    const unsubscribeSettings = window.lin?.onSettingsChanged?.(() => {
      void refreshProviderSettings();
      void refreshSlashCommands();
    });
    return () => {
      providerSettingsRequestRef.current += 1;
      slashCommandsRequestRef.current += 1;
      unsubscribeSettings?.();
      threadStore.dispose();
    };
  }, [refreshProviderSettings, refreshSlashCommands]);

  const title = useMemo(() => thread?.name || thread?.preview || t.agent.thread.untitled, [t, thread]);

  async function createThread() {
    if (creating || providerBlocksCreation) return;
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
          <button
            aria-expanded={listOpen}
            aria-label={t.agent.thread.list}
            className="thread-dock-title-button"
            onClick={() => setListOpen((current) => !current)}
            ref={threadListAnchorRef}
            type="button"
          >
            <HashIcon className="thread-dock-title-leading" size={ICON_SIZE.menu} />
            <span className="thread-dock-title">{thread ? title : t.agent.thread.title}</span>
            <ChevronDownIcon
              className={`thread-title-chevron${listOpen ? ' is-open' : ''}`}
              size={ICON_SIZE.menu}
            />
          </button>
          <div className="thread-dock-actions">
            <IconButton
              className="thread-dock-action"
              disabled={creating || providerBlocksCreation}
              icon={AddIcon}
              label={t.agent.thread.new}
              onClick={() => void createThread()}
              title={providerBlocksCreation ? t.agent.thread.providerRequired : t.agent.thread.new}
              variant="panel"
            />
            {thread ? (
              <div className="thread-header-actions">
                <IconButton
                  aria-expanded={actionsOpen}
                  icon={MoreIcon}
                  label={t.agent.thread.actions}
                  onClick={() => setActionsOpen((current) => !current)}
                  ref={actionsAnchorRef}
                  variant="panel"
                />
                {actionsOpen ? createPortal(
                  <div
                    aria-label={t.agent.thread.actions}
                    className="thread-header-menu"
                    onKeyDown={onActionsKeyDown}
                    ref={actionsMenuRef}
                    role="menu"
                    style={actionsMenuStyle}
                  >
                    <button onClick={() => { setActionsOpen(false); setDetailsOpen(true); }} role="menuitem" type="button">
                      <InfoIcon size={ICON_SIZE.menu} />{t.agent.thread.details}
                    </button>
                    <button onClick={() => { setActionsOpen(false); beginRename(thread); }} role="menuitem" type="button">
                      <PencilIcon size={ICON_SIZE.menu} />{t.agent.thread.rename}
                    </button>
                    <button onClick={() => { setActionsOpen(false); setDeleteTarget(thread); }} role="menuitem" type="button">
                      <TrashIcon size={ICON_SIZE.menu} />{t.agent.thread.delete}
                    </button>
                  </div>,
                  document.body,
                ) : null}
              </div>
            ) : null}
          </div>
        </header>
        {actionError || providerError || snapshot.error ? (
          <div className="thread-dock-error" role="alert">
            <WarningIcon size={ICON_SIZE.menu} />
            <span>{actionError ?? providerError ?? snapshot.error}</span>
          </div>
        ) : null}
        {snapshot.loading ? <p className="thread-empty-copy">{t.agent.thread.loading}</p> : null}
        {!snapshot.loading && !thread ? (
          <div className="thread-empty-state">
            <p>{providerBlocksCreation ? t.agent.thread.providerRequired : t.agent.thread.empty}</p>
            <button
              className="button button-primary"
              disabled={creating}
              onClick={() => {
                if (providerBlocksCreation) void window.lin?.openSettings?.({ category: 'providers' });
                else void createThread();
              }}
              type="button"
            >
              {providerBlocksCreation
                ? <SettingsIcon size={ICON_SIZE.menu} />
                : <AddIcon size={ICON_SIZE.menu} />}
              {providerBlocksCreation ? t.agent.thread.openSettings : t.agent.thread.new}
            </button>
          </div>
        ) : null}
        {thread ? (
          <>
            <ThreadView
              composerEnabled={thread.parentThreadId === null && thread.threadSource === 'user'}
              composerFocusToken={composerFocusToken}
              configuration={configuration}
              goal={goal}
              index={index}
              inputRequest={userInput ?? null}
              key={thread.id}
              onConfigurationChange={(next) => threadStore.setThreadConfiguration(thread.id, next)}
              onEditUserMessage={(turn, content: readonly ThreadUserContent[]) => (
                threadStore.forkAndSend(thread.id, turn.id, 'beforeTurn', content).then(() => undefined)
              )}
              onFork={(turn, kind) => threadStore.fork(thread.id, turn.id, kind).then(() => undefined)}
              onInterrupt={() => threadStore.interrupt(thread.id)}
              onOpenNodeReference={onOpenNodeReference}
              onOpenThread={(threadId) => threadStore.selectThread(threadId)}
              onRegenerate={regenerate}
              onSend={(content) => threadStore.send(content)}
              onSubmitUserInput={(answers) => userInput
                ? threadStore.respondToUserInput(userInput, answers)
                : Promise.resolve()}
              providerSettings={providerSettings}
              providerSettingsLoaded={providerSettingsLoaded}
              slashCommands={slashCommands}
              threadId={thread.id}
              threadModelProvider={thread.modelProvider}
              turns={turns}
            />
          </>
        ) : null}
        {listOpen ? (
          <ThreadList
            anchorRef={threadListAnchorRef}
            createDisabled={creating || providerBlocksCreation}
            createTitle={providerBlocksCreation ? t.agent.thread.providerRequired : t.agent.thread.new}
            onClose={() => setListOpen(false)}
            onCreate={() => void createThread()}
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

function slashCommandsFromSkills(skills: readonly SkillDefinition[]): AgentSlashCommandView[] {
  return skills
    .filter((skill) => skill.userInvocable)
    .map((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'skill' as const,
      label: `/${skill.name}`,
      description: slashCommandDescription(skill),
      insertText: `/${skill.name} `,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function slashCommandDescription(skill: SkillDefinition): string {
  const detail = skill.description.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  if (!skill.displayName || skill.displayName === detail) return detail;
  return detail ? `${skill.displayName} - ${detail}` : skill.displayName;
}
