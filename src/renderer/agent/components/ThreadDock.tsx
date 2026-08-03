import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { RendererUserViewHints, Thread, ThreadUserContent, Turn } from '../../../core/agent/protocol';
import type { AgentProviderSettingsView, AgentSlashCommandView, SkillDefinition } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { threadStore, useThreadStore } from '../store/threadStore';
import {
  BackIcon,
  ChevronDownIcon,
  ICON_SIZE,
  ScheduledIcon,
  SettingsIcon,
  StopIcon,
  WarningIcon,
} from '../../ui/icons';
import { Button } from '../../ui/primitives/Button';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { Dialog } from '../../ui/primitives/Dialog';
import { Input } from '../../ui/primitives/Input';
import { IconButton } from '../../ui/primitives/IconButton';
import { ResizeHandle } from '../../ui/primitives/ResizeHandle';
import { ThreadList } from './ThreadList';
import { ThreadDetailsDialog } from './ThreadDetailsDialog';
import { ThreadView } from './ThreadView';
import { resolveUsableActiveProvider } from '../../ui/agent/providerUsability';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import { NEW_THREAD_SLASH_COMMAND_ID } from '../threadComposerCommands';

const AutomationsView = lazy(async () => {
  const module = await import('../automations/AutomationsView');
  return { default: module.AutomationsView };
});

export type ThreadRailState = 'collapsed' | 'open';

interface ThreadDockProps {
  readonly index: DocumentIndex;
  readonly railState: ThreadRailState;
  readonly userView: RendererUserViewHints;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenTurnDetails: (threadId: string, turnId: string) => void;
  readonly onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onResizeReset: () => void;
  readonly onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function ThreadDock({
  index,
  railState,
  userView,
  onOpenNodeReference,
  onOpenTurnDetails,
  onResizeKeyDown,
  onResizeReset,
  onResizeStart,
}: ThreadDockProps) {
  const t = useT();
  const snapshot = useThreadStore();
  const [listOpen, setListOpen] = useState(false);
  const [surface, setSurface] = useState<'thread' | 'automations'>('thread');
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
  const threadsById = useMemo(
    () => new Map(snapshot.threads.map((candidate) => [candidate.id, candidate])),
    [snapshot.threads],
  );
  // The history list is root conversations only; a child Thread is an execution
  // artifact of a Turn, reachable from its parent rather than from the list.
  const rootThreads = useMemo(
    () => snapshot.threads.filter((candidate) => candidate.parentThreadId === null),
    [snapshot.threads],
  );
  const parentThread = thread?.parentThreadId ? threadsById.get(thread.parentThreadId) ?? null : null;
  /**
   * Stop reaches a user's own conversations only, so the affordance appears
   * only where the host would honour it. An automation's Subagent is running
   * work under a feature root: offering a Stop there would refuse and then
   * report live work as finished.
   */
  const stoppableChild = surface === 'thread'
    && thread !== null
    && thread.parentThreadId !== null
    && thread.status.type === 'active'
    && lineageRoot(thread, threadsById)?.threadSource === 'user';
  /**
   * "This conversation has background work running" — either the unselected
   * root itself is active, or one of its descendants is. The selected root's
   * own foreground Turn does not need a duplicate background indicator.
   */
  const rootsWithBackgroundWork = useMemo(() => {
    const parentById = new Map(snapshot.threads.map((candidate) => [candidate.id, candidate.parentThreadId]));
    const roots = new Set<string>();
    for (const candidate of snapshot.threads) {
      if (candidate.status.type !== 'active') continue;
      if (candidate.parentThreadId === null) {
        if (candidate.id !== snapshot.selectedThreadId) roots.add(candidate.id);
        continue;
      }
      const seen = new Set<string>([candidate.id]);
      let current: string | null = candidate.parentThreadId;
      while (current !== null && !seen.has(current)) {
        seen.add(current);
        const next: string | null | undefined = parentById.get(current);
        // An unknown ancestor means the chain cannot be attributed to a root.
        // Marking the mid-chain id instead would light no row at all, which is
        // worse than an honest absence — the indicator keys on root ids.
        if (next === undefined) { current = null; break; }
        if (next === null) break;
        current = next;
      }
      if (current !== null) roots.add(current);
    }
    return roots;
  }, [snapshot.selectedThreadId, snapshot.threads]);
  const turns = thread ? snapshot.turnsByThread.get(thread.id) ?? [] : [];
  const goal = thread ? snapshot.goalsByThread.get(thread.id) ?? null : null;
  const configuration = thread ? snapshot.configurationsByThread.get(thread.id) ?? null : null;
  const userInput = thread ? snapshot.userInputByThread.get(thread.id) ?? null : null;
  const providerRetry = thread ? snapshot.providerRetryByThread.get(thread.id) ?? null : null;
  const plan = thread ? snapshot.planByThread.get(thread.id) ?? null : null;
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
        setSlashCommands(slashCommandsFromSkills(skills, {
          compactDescription: t.agent.composer.compactCommandDescription,
          clearDescription: t.agent.composer.clearCommandDescription,
          newThreadDescription: t.agent.composer.newThreadCommandDescription,
        }));
      }
    } catch {
      if (slashCommandsRequestRef.current === request) {
        setSlashCommands(runtimeSlashCommands({
          compactDescription: t.agent.composer.compactCommandDescription,
          clearDescription: t.agent.composer.clearCommandDescription,
          newThreadDescription: t.agent.composer.newThreadCommandDescription,
        }));
      }
    }
  }, [t]);

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
  const parentThreadTitle = parentThread
    ? parentThread.name || parentThread.preview || t.agent.thread.untitled
    : null;

  /**
   * Every transcript and details link goes through here: `openThreadById`
   * recovers a Thread the catalog does not have, and a genuinely deleted one
   * surfaces the existing dock feedback instead of throwing behind a bare void.
   */
  /**
   * Stop one delegated child. Failure is reported, not swallowed: the host
   * refuses a Turn that already settled, and a Stop that silently did nothing
   * is worse than one that says so.
   */
  const interruptThread = useCallback(async (threadId: string) => {
    setActionError(null);
    try {
      await threadStore.interruptThread(threadId);
    } catch {
      setActionError(t.agent.thread.stopUnavailable);
    }
  }, [t]);

  const openThread = useCallback(async (threadId: string) => {
    setActionError(null);
    try {
      await threadStore.openThreadById(threadId);
      setListOpen(false);
    } catch {
      setActionError(t.agent.thread.threadUnavailable);
    }
  }, [t]);

  const createThread = useCallback(async () => {
    if (creatingRef.current || providerBlocksCreation) return false;
    creatingRef.current = true;
    setCreating(true);
    setActionError(null);
    try {
      await threadStore.createThread();
      setListOpen(false);
      setComposerFocusToken((token) => token + 1);
      return true;
    } catch (error) {
      setActionError(errorMessage(error));
      return false;
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
          {surface === 'thread' ? (
            // A child Thread is entered from a parent transcript, so it gains a
            // crumb back out — but never at the cost of the list: that button is
            // the only route to create, details, rename, and delete, and it is
            // the child's own name that carries it, so no Thread is unnamed and
            // no view is a dead end.
            <div className="thread-dock-breadcrumb">
              {thread?.parentThreadId ? (
                <>
                  <button
                    aria-label={parentThreadTitle
                      ? t.agent.thread.backToParent({ name: parentThreadTitle })
                      : t.agent.thread.backToParentFallback}
                    className="thread-dock-title-button thread-dock-back"
                    onClick={() => void openThread(thread.parentThreadId!)}
                    type="button"
                  >
                    <BackIcon className="thread-dock-title-leading" size={ICON_SIZE.menu} />
                    <span className="thread-dock-back-label">{parentThreadTitle ?? t.agent.thread.title}</span>
                  </button>
                  <span aria-hidden className="thread-dock-breadcrumb-separator">/</span>
                </>
              ) : null}
              <button
                aria-expanded={listOpen}
                aria-label={t.agent.thread.list}
                className="thread-dock-title-button"
                onClick={() => setListOpen((current) => !current)}
                ref={threadListAnchorRef}
                type="button"
              >
                <span className="thread-dock-title">{thread ? title : t.agent.thread.title}</span>
                <ChevronDownIcon
                  className={`thread-title-chevron${listOpen ? ' is-open' : ''}`}
                  size={ICON_SIZE.menu}
                />
              </button>
            </div>
          ) : (
            <button
              aria-label={t.agent.automations.backToThreads}
              className="thread-dock-title-button"
              onClick={() => setSurface('thread')}
              type="button"
            >
              <BackIcon className="thread-dock-title-leading" size={ICON_SIZE.menu} />
              <span className="thread-dock-title">{t.agent.automations.title}</span>
            </button>
          )}
          {stoppableChild ? (
            <IconButton
              className="thread-dock-surface-action"
              icon={StopIcon}
              label={t.agent.thread.stopThisSubagent}
              onClick={() => void interruptThread(thread!.id)}
              strokeWidth={1.7}
              variant="chrome"
            />
          ) : null}
          {surface === 'thread' ? (
            <IconButton
              className="thread-dock-surface-action"
              icon={ScheduledIcon}
              label={t.agent.automations.open}
              onClick={() => {
                setListOpen(false);
                setSurface('automations');
              }}
              strokeWidth={1.7}
              variant="chrome"
            />
          ) : null}
        </header>
        {actionError || providerError || snapshot.error ? (
          <div className="thread-dock-error" role="alert">
            <WarningIcon size={ICON_SIZE.menu} />
            <span>{actionError ?? providerError ?? snapshot.error}</span>
          </div>
        ) : null}
        {surface === 'thread' && snapshot.loading ? <p className="thread-empty-copy">{t.agent.thread.loading}</p> : null}
        {surface === 'thread' && !snapshot.loading && !thread && providerSettingsLoaded && providerBlocksCreation ? (
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
        {surface === 'thread' && thread ? (
          <>
            <ThreadView
              composerEnabled={thread.parentThreadId === null && thread.threadSource === 'user'}
              composerFocusToken={composerFocusToken}
              configuration={configuration}
              goal={goal}
              index={index}
              inputRequest={userInput ?? null}
              waitingOnUserInput={thread.status.type === 'active'
                && thread.status.activeFlags.includes('waitingOnUserInput')}
              key={thread.id}
              onConfigurationChange={(next) => threadStore.setThreadConfiguration(thread.id, next)}
              onCreateThread={createThread}
              onEditUserMessage={(_turn, content: readonly ThreadUserContent[]) => (
                threadStore.rollbackAndSend(thread.id, content, userView)
              )}
              onContinueInNewChat={(turn) => threadStore.continueInNewChat(thread.id, turn.id).then(() => undefined)}
              onInterrupt={() => threadStore.interrupt(thread.id)}
              onInterruptThread={interruptThread}
              onOpenNodeReference={onOpenNodeReference}
              onOpenThread={openThread}
              onOpenTurnDetails={(turn) => onOpenTurnDetails(thread.id, turn.id)}
              onReadToolOutput={(turnId, item) => threadStore.readItemOutput(thread.id, turnId, item)}
              onSend={(content) => threadStore.send(content, userView)}
              onSubmitUserInput={(answers) => userInput
                ? threadStore.respondToUserInput(userInput, answers)
                : Promise.resolve()}
              providerSettings={providerSettings}
              providerSettingsLoaded={providerSettingsLoaded}
              providerRetry={providerRetry}
              plan={plan}
              slashCommands={slashCommands}
              threadCreationBlocked={providerBlocksCreation}
              threadCreationPending={creating}
              threadCwd={thread.cwd}
              threadId={thread.id}
              threadModelProvider={thread.modelProvider}
              threadsById={threadsById}
              latestTurnByThread={snapshot.latestTurnByThread}
              turns={turns}
            />
          </>
        ) : null}
        {surface === 'automations' ? (
          <Suspense fallback={<p className="thread-empty-copy">{t.agent.automations.loading}</p>}>
            <AutomationsView
              onOpenThread={async (threadId) => {
                await openThread(threadId);
                setSurface('thread');
              }}
              providerSettings={providerSettings}
              threads={snapshot.threads}
            />
          </Suspense>
        ) : null}
        {surface === 'thread' && listOpen ? (
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
            backgroundWorkThreadIds={rootsWithBackgroundWork}
            selectedThreadId={snapshot.selectedThreadId}
            threads={rootThreads}
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
          onOpenThread={openThread}
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

/** The Thread a lineage roots at, or null when an ancestor is not in the catalog. */
function lineageRoot(thread: Thread, threadsById: ReadonlyMap<string, Thread>): Thread | null {
  const visited = new Set<string>();
  let current: Thread = thread;
  while (current.parentThreadId !== null) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    const parent = threadsById.get(current.parentThreadId);
    if (!parent) return null;
    current = parent;
  }
  return current;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RuntimeSlashCommandLabels {
  readonly compactDescription: string;
  readonly clearDescription: string;
  readonly newThreadDescription: string;
}

function runtimeSlashCommands(labels: RuntimeSlashCommandLabels): AgentSlashCommandView[] {
  return [
    {
      id: NEW_THREAD_SLASH_COMMAND_ID,
      kind: 'runtime',
      label: '/new',
      description: labels.newThreadDescription,
      insertText: '/new',
    },
    {
      id: 'runtime:compact',
      kind: 'runtime',
      label: '/compact',
      description: labels.compactDescription,
      insertText: '/compact ',
    },
    {
      id: 'runtime:clear',
      kind: 'runtime',
      label: '/clear',
      description: labels.clearDescription,
      insertText: '/clear',
    },
  ];
}

function slashCommandsFromSkills(
  skills: readonly SkillDefinition[],
  labels: RuntimeSlashCommandLabels,
): AgentSlashCommandView[] {
  const skillCommands = skills
    .filter((skill) => skill.userInvocable)
    .map((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'skill' as const,
      label: `/${skill.name}`,
      description: slashCommandDescription(skill),
      insertText: `/${skill.name} `,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  return [...runtimeSlashCommands(labels), ...skillCommands];
}

function slashCommandDescription(skill: SkillDefinition): string {
  const detail = skill.description.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  if (!skill.displayName || skill.displayName === detail) return detail;
  return detail ? `${skill.displayName} - ${detail}` : skill.displayName;
}
