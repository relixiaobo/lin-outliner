import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { RendererUserViewHints, Thread, ThreadUserContent, Turn } from '../../../core/agent/protocol';
import type { AgentProviderSettingsView, AgentSlashCommandView } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { threadStore, useThreadStore } from '../store/threadStore';
import {
  EMPTY_SUBAGENT_PROJECTION,
  projectSubagentConversation,
  type SubagentConversationProjection,
} from '../subagentPresentation';
import { SubagentDetailTitle, SubagentDetailView } from './SubagentDetailView';
import type { SubagentRegistryEntry } from '../subagentPresentation';
import { SubagentRegistryProvider, type SubagentActions } from './SubagentRegistryContext';
import { SubagentWorkStrip } from './SubagentWorkStrip';
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
import { ThreadView } from './ThreadView';
import { resolveUsableActiveProvider } from '../../ui/agent/providerUsability';
import { reportActionError } from '../../ui/interactions/actionSteps';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import { runtimeSlashCommands, slashCommandsFromSkills } from '../threadComposerCommands';

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
  /**
   * The pushed Agent detail stack, root-most first. Empty is the conversation
   * itself; each entry is one level deeper, and Back pops exactly one.
   */
  const [agentStack, setAgentStack] = useState<readonly string[]>([]);
  const [creating, setCreating] = useState(false);
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
  /**
   * The conversation's Agent registry and anchors, projected once for the whole
   * subtree. The deck owns this rather than each Turn: an Agent outlives the
   * Turn that spawned it, and a resume six Turns later has to reach the chip
   * that already exists.
   */
  const subagentProjectionRef = useRef<SubagentConversationProjection | null>(null);
  const subagentProjection = useMemo(() => {
    if (!thread) return EMPTY_SUBAGENT_PROJECTION;
    const projection = projectSubagentConversation({
      rootThreadId: thread.id,
      turnsByThread: snapshot.turnsByThread,
      executions: snapshot.subagentExecutionsByAgentId,
      threadsById,
      latestTurnByThread: snapshot.latestTurnByThread,
    }, subagentProjectionRef.current);
    subagentProjectionRef.current = projection;
    return projection;
  }, [
    snapshot.latestTurnByThread,
    snapshot.subagentExecutionsByAgentId,
    snapshot.turnsByThread,
    thread,
    threadsById,
  ]);
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
    try {
      await threadStore.interruptThread(threadId);
    } catch {
      reportActionError(t.agent.thread.stopUnavailable);
    }
  }, [t]);

  /**
   * Open one Agent, from wherever it was named.
   *
   * Every anchor — a chip in the transcript, a strip row, a Thread Details row,
   * a nested chip inside another Agent — pushes the SAME view, so there is one
   * place an Agent is read and one gesture that gets there. A grandchild pushes
   * its whole lineage, so Back unwinds through the Agent that delegated it
   * rather than jumping straight back to the conversation.
   */
  const openSubagent = useCallback((agentId: string) => {
    setListOpen(false);
    const parentThreadId = snapshot.selectedThreadId;
    if (!parentThreadId) return;
    const path = lineagePathFromRoot(
      agentId,
      parentThreadId,
      threadsById,
      subagentProjectionRef.current?.byAgentId ?? new Map(),
    );
    if (!path) {
      reportActionError(t.agent.thread.threadUnavailable);
      return;
    }
    setAgentStack(path);
  }, [snapshot.selectedThreadId, t, threadsById]);

  const subagentActions = useMemo<SubagentActions>(() => ({
    openAgent: openSubagent,
    stopAgent: interruptThread,
  }), [interruptThread, openSubagent]);

  // A conversation switch leaves the stack behind with it: the Agents it held
  // belong to a conversation the user is no longer in.
  useEffect(() => { setAgentStack([]); }, [snapshot.selectedThreadId]);
  // An Agent whose record left the conversation cannot be shown, and the level
  // above it is the honest place to land.
  const openAgentStack = useMemo(() => {
    const known: string[] = [];
    for (const agentId of agentStack) {
      if (!subagentProjection.byAgentId.has(agentId)) break;
      known.push(agentId);
    }
    return known;
  }, [agentStack, subagentProjection]);
  const openAgentId = openAgentStack.at(-1) ?? null;

  /** Selecting a root conversation from the list or an Automation. */
  const openThread = useCallback(async (threadId: string) => {
    try {
      await threadStore.openThreadById(threadId);
      setListOpen(false);
    } catch {
      reportActionError(t.agent.thread.threadUnavailable);
    }
  }, [t]);

  const createThread = useCallback(async () => {
    if (creatingRef.current || providerBlocksCreation) return false;
    creatingRef.current = true;
    setCreating(true);
    try {
      await threadStore.createThread();
      setListOpen(false);
      setComposerFocusToken((token) => token + 1);
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
    try {
      await action();
    } catch (error) {
      reportActionError(errorMessage(error));
    }
  }

  return (
    <SubagentRegistryProvider actions={subagentActions} byAgentId={subagentProjection.byAgentId}>
    <aside
      aria-label={t.shell.agentDock.ariaLabel}
      className={`agent-dock agent-dock-${railState}`}
      data-rail-state={railState}
      inert={open ? undefined : true}
    >
      <div className="thread-dock">
        <header className="thread-dock-header">
          {surface === 'thread' && openAgentId === null ? (
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
          {surface === 'thread' && openAgentId !== null ? (
            // A pushed level TAKES the title bar, the way the Automations
            // surface beside it already does. Leaving the conversation's title
            // up there would make the loudest thing on screen the one thing the
            // reader is not looking at — and it would still offer a chevron
            // into a list that cannot act on what is below it.
            <SubagentDetailTitle
              onPop={() => setAgentStack((current) => current.slice(0, -1))}
              agentId={openAgentId}
              parentName={openAgentStack.length > 1
                ? subagentProjection.byAgentId.get(openAgentStack.at(-2)!)?.displayName
                  ?? t.agent.thread.agent.back
                : t.agent.thread.agent.back}
            />
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
          {surface === 'thread' && openAgentId === null ? (
            <SubagentWorkStrip byAgentId={subagentProjection.byAgentId} />
          ) : null}
          {surface === 'thread' && openAgentId === null ? (
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
          // The pushed view COVERS the conversation rather than replacing it in
          // the tree. Unmounting the transcript would throw away the reader's
          // place in it — and its measured layout — every time an Agent is
          // opened; covering keeps both, and `inert` keeps focus out of what is
          // no longer on screen.
          <div className="thread-dock-body">
            <div className={`thread-dock-conversation${openAgentId === null ? '' : ' is-covered'}`}>
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
              onOpenSubagentTurnDetails={onOpenTurnDetails}
              onOpenThread={async (threadId) => openSubagent(threadId)}
              onOpenTurnDetails={(turn) => onOpenTurnDetails(thread.id, turn.id)}
              onReadToolOutput={(turnId, item) => threadStore.readItemOutput(thread.id, turnId, item)}
              onReadToolArguments={(turnId, item) => threadStore.readToolArguments(thread.id, turnId, item)}
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
              subagentProjection={subagentProjection}
              userView={userView}
            />
            </div>
            {openAgentId !== null ? (
              <SubagentDetailView
                agentId={openAgentId}
                index={index}
                key={openAgentId}
                onOpenNodeReference={onOpenNodeReference}
                onOpenThread={openThread}
                onOpenTurnDetails={onOpenTurnDetails}
                subagentProjection={subagentProjection}
                userView={userView}
              />
            ) : null}
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
            createTitle={providerBlocksCreation ? t.agent.thread.providerRequired : t.agent.thread.new}
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
          onOpenThread={async (threadId) => {
            // Details is a browse surface for children, so its rows land in the
            // same drawer every other entry point does.
            setDetailsTarget(null);
            openSubagent(threadId);
          }}
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
    </SubagentRegistryProvider>
  );
}

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
export function lineagePathFromRoot(
  targetId: string,
  rootThreadId: string,
  threadsById: ReadonlyMap<string, Thread>,
  byAgentId: ReadonlyMap<string, SubagentRegistryEntry>,
): readonly string[] | null {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = targetId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const parentThreadId: string | null = byAgentId.get(current)?.parentThreadId
      ?? threadsById.get(current)?.parentThreadId
      ?? null;
    if (parentThreadId === null) return null;
    path.unshift(current);
    if (parentThreadId === rootThreadId) return path;
    current = parentThreadId;
  }
  return null;
}

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
