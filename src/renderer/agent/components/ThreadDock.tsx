import { lazy, memo, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { RendererUserViewHints, ThreadUserContent } from '../../../core/agent/protocol';
import type { Thread, Turn } from '../projectionTypes';
import type { AgentProviderSettingsView, AgentSlashCommandView } from '../../api/types';
import type { DocumentIndexStore } from '../../state/documentIndexStore';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { threadStore, useThreadStore } from '../store/threadStore';
import { ToolTaskStrip } from './ToolTaskStrip';
import {
  BackIcon,
  ChevronDownIcon,
  ICON_SIZE,
  ScheduledIcon,
  SettingsIcon,
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
import { MAIN_IDENTITY_KEY } from '../agentIdentity';
import { ThreadView } from './ThreadView';
import { resolveUsableActiveProvider } from '../../ui/agent/providerUsability';
import { reportActionError } from '../../ui/interactions/actionSteps';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import { runtimeSlashCommands, slashCommandsFromSkills } from '../threadComposerCommands';
import { shouldRestoreComposerAfterThreadCreation } from '../composerRefocus';
import { formatShortcutHint, matchesShortcutEvent } from '../../ui/interactions/shortcutRegistry';

const AutomationsView = lazy(async () => {
  const module = await import('../automations/AutomationsView');
  return { default: module.AutomationsView };
});

export type ThreadRailState = 'collapsed' | 'open';

interface ThreadDockProps {
  readonly getUserView: () => RendererUserViewHints;
  readonly indexStore: DocumentIndexStore;
  readonly railState: ThreadRailState;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenTurnDetails: (threadId: string, turnId?: string) => void;
  readonly onRequestOpen: () => void;
  readonly onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onResizeReset: () => void;
  readonly onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export const ThreadDock = memo(function ThreadDock({
  getUserView,
  indexStore,
  railState,
  onOpenNodeReference,
  onOpenTurnDetails,
  onRequestOpen,
  onResizeKeyDown,
  onResizeReset,
  onResizeStart,
}: ThreadDockProps) {
  const t = useT();
  const open = railState === 'open';
  const snapshot = useThreadStore(open);
  const [listOpen, setListOpen] = useState(false);
  const [surface, setSurface] = useState<'thread' | 'automations'>('thread');
  /**
   * The pushed Agent detail stack, root-most first. Empty is the conversation
   * itself; each entry is one level deeper, and Back pops exactly one.
   */
  const [creating, setCreating] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Thread | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Thread | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<Thread | null>(null);
  const [providerSettings, setProviderSettings] = useState<AgentProviderSettingsView | null>(null);
  const [providerSettingsLoaded, setProviderSettingsLoaded] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [composerFocusRequest, setComposerFocusRequest] = useState<{
    readonly token: number;
    readonly expectedActiveElement: Element | null;
  }>({ token: 0, expectedActiveElement: null });
  const [slashCommands, setSlashCommands] = useState<AgentSlashCommandView[]>([]);
  const renameTitleId = useId();
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const threadListAnchorRef = useRef<HTMLButtonElement | null>(null);
  const creatingRef = useRef(false);
  const autoCreateAttemptedRef = useRef(false);
  const providerSettingsRequestRef = useRef(0);
  const slashCommandsRequestRef = useRef(0);
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
  /**
   * "This conversation has background work running" — either the unselected
   * root itself is active, or one of its descendants is. The selected root's
   * own foreground Turn does not need a duplicate background indicator.
   */
  const rootsWithBackgroundWork = useMemo(() => {
    const parentById = new Map(snapshot.threads.map((candidate) => [candidate.id, candidate.parentThreadId]));
    const roots = new Set<string>();
    for (const candidate of snapshot.threads) {
      if (
        candidate.status.type !== 'active'
        || candidate.status.activeFlags.includes('waitingOnUserInput')
      ) continue;
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
  const toolTasks = useMemo(() => thread
    ? [...snapshot.toolTasksById.values()].filter((task) => task.ownerThreadId === thread.id)
    : [], [snapshot.toolTasksById, thread]);
  const userInput = thread ? snapshot.userInputByThread.get(thread.id) ?? null : null;
  const providerRetry = thread ? snapshot.providerRetryByThread.get(thread.id) ?? null : null;
  const plan = thread ? snapshot.planByThread.get(thread.id) ?? null : null;
  const providerBlocksCreation = providerSettingsLoaded
    && (!providerSettings || !resolveUsableActiveProvider(providerSettings));
  const newThreadShortcutHint = formatShortcutHint('global.new_thread');
  useEffect(() => {
    if (open && !openRef.current) {
      setComposerFocusRequest((current) => ({
        token: current.token + 1,
        expectedActiveElement: document.activeElement,
      }));
    }
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
  // Stable across renders: minted inline it handed the memoized `ThreadTurnView`
  // a new identity on every store patch, so the whole transcript re-rendered on
  // every streaming frame — the exact hot path #541 optimized.
  const conversationSpeaker = useMemo(() => ({
    participantId: MAIN_IDENTITY_KEY,
    avatarKey: MAIN_IDENTITY_KEY,
    name: t.agent.thread.agent.main,
  }), [t]);

  /** Selecting a root conversation from the list or an Automation. */
  const openThread = useCallback(async (threadId: string) => {
    try {
      await threadStore.openThreadById(threadId);
      setListOpen(false);
    } catch {
      reportActionError(t.agent.thread.threadUnavailable);
    }
  }, [t]);

  const createThread = useCallback(async (
    focusMode: 'automatic' | 'explicit' = 'explicit',
  ) => {
    if (creatingRef.current || providerBlocksCreation) return false;
    const focusAtStart = document.activeElement;
    creatingRef.current = true;
    setCreating(true);
    try {
      await threadStore.createThread();
      const restoreComposerFocus = shouldRestoreComposerAfterThreadCreation(
        focusMode,
        focusAtStart,
        document.activeElement,
        document.body,
      );
      setListOpen(false);
      if (restoreComposerFocus) {
        setComposerFocusRequest((current) => ({
          token: current.token + 1,
          expectedActiveElement: document.activeElement,
        }));
      }
      return true;
    } catch (error) {
      reportActionError(errorMessage(error));
      return false;
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [providerBlocksCreation]);

  useEffect(() => {
    const handleNewThreadShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.repeat
        || creatingRef.current
        || !providerSettingsLoaded
        || providerBlocksCreation
        || !matchesShortcutEvent(event, 'global.new_thread')
      ) return;
      event.preventDefault();
      void createThread().then((created) => {
        if (created) onRequestOpen();
      });
    };
    window.addEventListener('keydown', handleNewThreadShortcut);
    return () => window.removeEventListener('keydown', handleNewThreadShortcut);
  }, [createThread, onRequestOpen, providerBlocksCreation, providerSettingsLoaded]);

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
    void createThread('automatic');
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
    try {
      await action();
    } catch (error) {
      reportActionError(errorMessage(error));
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
            // The dock's title is the conversation the user started, and its
            // chevron opens the list of them.
            <div className="thread-dock-breadcrumb">
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
          ) : null}
          {surface === 'automations' ? (
            <button
              aria-label={t.agent.automations.backToThreads}
              className="thread-dock-title-button"
              onClick={() => setSurface('thread')}
              type="button"
            >
              <BackIcon className="thread-dock-title-leading" size={ICON_SIZE.menu} />
              <span className="thread-dock-title">{t.agent.automations.title}</span>
            </button>
          ) : null}
          {surface === 'thread' && thread ? (
            <ToolTaskStrip
              onClearDetails={(threadId) => threadStore.clearToolTaskDetails(threadId)}
              onRead={(threadId, taskId) => threadStore.readToolTask(threadId, taskId)}
              onStop={(threadId, taskId) => threadStore.stopToolTask(threadId, taskId)}
              ownerThreadId={thread.id}
              tasks={toolTasks}
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

              variant="chrome"
            />
          ) : null}
        </header>
        {/* Conditions only. A provider that is not configured and a thread list
            that failed to load describe THIS surface and persist until they are
            resolved, so they are stated here and cannot be dismissed. A failed
            action is not a condition: it goes to the app's one notice, the same
            place an outliner or pane failure goes. */}
        {providerError || snapshot.error ? (
          <div className="thread-dock-error" role="alert">
            <WarningIcon size={ICON_SIZE.menu} />
            <span>{providerError ?? snapshot.error}</span>
          </div>
        ) : null}
        {surface === 'thread' && snapshot.loading ? <p className="thread-empty-copy">{t.agent.thread.loading}</p> : null}
        {surface === 'thread' && !snapshot.loading && !thread && providerSettingsLoaded && providerBlocksCreation ? (
          <div className="thread-empty-state">
            <p>{t.agent.thread.providerRequired}</p>
            <button
              className="button button-primary"
              disabled={creating}
              onClick={() => void window.lin?.openSettings?.({ page: 'services' })}
              type="button"
            >
              <SettingsIcon size={ICON_SIZE.menu} />
              {t.agent.thread.openSettings}
            </button>
          </div>
        ) : null}
        {surface === 'thread' && thread ? (
          <div className="thread-dock-body">
            <div className="thread-dock-conversation">
            <ThreadView
              active={open}
              composerEnabled={thread.parentThreadId === null && thread.threadSource === 'user'}
              composerFocusExpectedActiveElement={composerFocusRequest.expectedActiveElement}
              composerFocusToken={composerFocusRequest.token}
              selfSpeaker={conversationSpeaker}
              configuration={configuration}
              getUserView={getUserView}
              goal={goal}
              indexStore={indexStore}
              inputRequest={userInput ?? null}
              waitingOnUserInput={thread.status.type === 'active'
                && thread.status.activeFlags.includes('waitingOnUserInput')}
              key={thread.id}
              onConfigurationChange={(next) => threadStore.setThreadConfiguration(thread.id, next)}
              onCreateThread={createThread}
              onEditUserMessage={(_turn, content: readonly ThreadUserContent[]) => (
                threadStore.rollbackAndSend(thread.id, content, getUserView())
              )}
              onReadTurnRecovery={(turn) => threadStore.readTurnRecovery(thread.id, turn.id)}
              onContinueTurn={(turn) => threadStore.continueTurn(thread.id, turn.id)}
              onRerunTurn={(turn, confirmToolReplay) => (
                threadStore.rerunTurn(thread.id, turn.id, confirmToolReplay)
              )}
              onContinueInNewChat={(turn) => threadStore.continueInNewChat(thread.id, turn.id).then(() => undefined)}
              onInterrupt={() => threadStore.interrupt(thread.id)}
              onOpenNodeReference={onOpenNodeReference}
              onOpenThreadReference={openThread}
              onOpenTurnDetails={(turn) => onOpenTurnDetails(thread.id, turn.id)}
              onReadToolOutput={(turnId, item) => threadStore.readItemOutput(thread.id, turnId, item)}
              onReadToolArguments={(turnId, item) => threadStore.readToolArguments(thread.id, turnId, item)}
              onSend={(content, clientMessageId) => threadStore.send(content, getUserView(), clientMessageId)}
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
              turns={turns}
            />
            </div>
          </div>
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
            createTitle={providerBlocksCreation
              ? t.agent.thread.providerRequired
              : newThreadShortcutHint
                ? `${t.agent.thread.new} (${newThreadShortcutHint})`
                : t.agent.thread.new}
            onClose={() => setListOpen(false)}
            onCreate={() => void createThread()}
            onDelete={setDeleteTarget}
            onDetails={(target) => void openDetails(target)}
            onRename={beginRename}
            onSetRecorded={(target, recorded) => {
              void runAction(async () => { await threadStore.setThreadRecorded(target.id, recorded); });
            }}
            readRecorded={(target) => threadStore.readThreadRecorded(target.id)}
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
});

/**
 * The chain from the conversation's own child down to `targetId`, or null when
 * the target is not in this conversation's subtree at all.
 *
 * The Agent REGISTRY is asked first, because the execution record carries the
 * canonical delegation edge while the Thread catalog is a cache that starts
 * cold: `thread/list` is roots-only, so on the launch a conversation is
 * restored into, its Agents have records and chips before their child Threads
 * have been read. Resolving from the catalog alone reported them gone.
 */
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
