import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Thread, ThreadUserContent, Turn } from '../../../core/agent/protocol';
import type { AgentProviderSettingsView, AgentSlashCommandView, SkillDefinition } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { threadStore, useThreadStore } from '../store/threadStore';
import {
  AgentIcon,
  ChevronDownIcon,
  ICON_SIZE,
  SettingsIcon,
  WarningIcon,
} from '../../ui/icons';
import { Button } from '../../ui/primitives/Button';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { Dialog } from '../../ui/primitives/Dialog';
import { Input } from '../../ui/primitives/Input';
import { ResizeHandle } from '../../ui/primitives/ResizeHandle';
import { ThreadList } from './ThreadList';
import { ThreadDetailsDialog } from './ThreadDetailsDialog';
import { ThreadView } from './ThreadView';
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
  const [detailsTarget, setDetailsTarget] = useState<Thread | null>(null);
  const [providerSettings, setProviderSettings] = useState<AgentProviderSettingsView | null>(null);
  const [providerSettingsLoaded, setProviderSettingsLoaded] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const [slashCommands, setSlashCommands] = useState<AgentSlashCommandView[]>([]);
  const renameTitleId = useId();
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const threadListAnchorRef = useRef<HTMLButtonElement | null>(null);
  const creatingRef = useRef(false);
  const autoCreateAttemptedRef = useRef(false);
  const providerSettingsRequestRef = useRef(0);
  const slashCommandsRequestRef = useRef(0);
  const open = railState === 'open';
  const openRef = useRef(open);
  const thread = snapshot.threads.find((candidate) => candidate.id === snapshot.selectedThreadId) ?? null;
  const turns = thread ? snapshot.turnsByThread.get(thread.id) ?? [] : [];
  const goal = thread ? snapshot.goalsByThread.get(thread.id) ?? null : null;
  const configuration = thread ? snapshot.configurationsByThread.get(thread.id) ?? null : null;
  const userInput = thread ? snapshot.userInputByThread.get(thread.id) ?? null : null;
  const providerRetry = thread ? snapshot.providerRetryByThread.get(thread.id) ?? null : null;
  const providerBlocksCreation = providerSettingsLoaded
    && (!providerSettings || !resolveUsableActiveProvider(providerSettings));
  useEffect(() => {
    if (open && !openRef.current) setComposerFocusToken((token) => token + 1);
    openRef.current = open;
  }, [open]);

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

  const createThread = useCallback(async () => {
    if (creatingRef.current || providerBlocksCreation) return;
    creatingRef.current = true;
    setCreating(true);
    setActionError(null);
    try {
      await threadStore.createThread();
      setListOpen(false);
      setComposerFocusToken((token) => token + 1);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [providerBlocksCreation]);

  useEffect(() => {
    if (thread) {
      autoCreateAttemptedRef.current = false;
      return;
    }
    if (
      snapshot.loading
      || snapshot.error !== null
      || !providerSettingsLoaded
      || providerBlocksCreation
      || autoCreateAttemptedRef.current
    ) return;
    autoCreateAttemptedRef.current = true;
    void createThread();
  }, [createThread, providerBlocksCreation, providerSettingsLoaded, snapshot.error, snapshot.loading, thread]);

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

  async function openDetails(target: Thread) {
    await runAction(async () => {
      await threadStore.selectThread(target.id);
      setDetailsTarget(target);
    });
  }

  async function runAction(action: () => Promise<void>) {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
    }
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
            <AgentIcon className="thread-dock-title-leading" size={ICON_SIZE.menu} />
            <span className="thread-dock-title">{thread ? title : t.agent.thread.title}</span>
            <ChevronDownIcon
              className={`thread-title-chevron${listOpen ? ' is-open' : ''}`}
              size={ICON_SIZE.menu}
            />
          </button>
        </header>
        {actionError || providerError || snapshot.error ? (
          <div className="thread-dock-error" role="alert">
            <WarningIcon size={ICON_SIZE.menu} />
            <span>{actionError ?? providerError ?? snapshot.error}</span>
          </div>
        ) : null}
        {snapshot.loading ? <p className="thread-empty-copy">{t.agent.thread.loading}</p> : null}
        {!snapshot.loading && !thread && providerSettingsLoaded && providerBlocksCreation ? (
          <div className="thread-empty-state">
            <p>{t.agent.thread.providerRequired}</p>
            <button
              className="button button-primary"
              disabled={creating}
              onClick={() => void window.lin?.openSettings?.({ category: 'providers' })}
              type="button"
            >
              <SettingsIcon size={ICON_SIZE.menu} />
              {t.agent.thread.openSettings}
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
              onEditUserMessage={(_turn, content: readonly ThreadUserContent[]) => (
                threadStore.rollbackAndSend(thread.id, content)
              )}
              onContinueInNewChat={(turn) => threadStore.continueInNewChat(thread.id, turn.id).then(() => undefined)}
              onInterrupt={() => threadStore.interrupt(thread.id)}
              onOpenNodeReference={onOpenNodeReference}
              onOpenThread={(threadId) => threadStore.selectThread(threadId)}
              onReadToolOutput={(turnId, item) => threadStore.readItemOutput(thread.id, turnId, item)}
              onSend={(content) => threadStore.send(content)}
              onSubmitUserInput={(answers) => userInput
                ? threadStore.respondToUserInput(userInput, answers)
                : Promise.resolve()}
              providerSettings={providerSettings}
              providerSettingsLoaded={providerSettingsLoaded}
              providerRetry={providerRetry}
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
            onDetails={(target) => void openDetails(target)}
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
      {detailsTarget ? (
        <ThreadDetailsDialog
          onClose={() => setDetailsTarget(null)}
          thread={detailsTarget}
          turns={snapshot.turnsByThread.get(detailsTarget.id) ?? []}
        />
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
