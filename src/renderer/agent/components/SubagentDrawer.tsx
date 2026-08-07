import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Thread, ThreadId, Turn } from '../../../core/agent/protocol';
import type { DocumentIndex } from '../../state/document';
import { useT } from '../../i18n/I18nProvider';
import { AgentIcon, BackIcon, CloseIcon, ICON_SIZE, SkillIcon, StopIcon } from '../../ui/icons';
import { Dialog } from '../../ui/primitives/Dialog';
import { IconButton } from '../../ui/primitives/IconButton';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import { threadStore, type ThreadStoreSnapshot } from '../store/threadStore';
import { ThreadView } from './ThreadView';

/**
 * A delegated child, read where it happened.
 *
 * A child Thread is an execution artifact of a Turn, not a conversation — the
 * Thread list already says so by not listing it. Navigating to one contradicted
 * that: the dock swapped its whole view, and arriving somewhere you did not
 * choose to go reads as having been moved rather than having opened something.
 *
 * So the child rises over the parent instead. The parent stays selected and
 * MOUNTED behind the scrim, which is what makes the promise cheap: there is no
 * scroll position to snapshot and restore, because the transcript underneath was
 * never unmounted or scrolled. Opening and closing are one gesture and its
 * inverse, and the composer keeps talking to the conversation it always did.
 */
export function SubagentDrawer({
  index,
  onBack,
  onClose,
  onInterruptThread,
  onOpenNodeReference,
  onOpenSubagent,
  onOpenTurnDetails,
  parentName,
  restoreFocus,
  snapshot,
  stoppable,
  threadId,
}: {
  readonly index: DocumentIndex;
  /** Present only for a grandchild: one level back, never a stack of drawers. */
  readonly onBack: (() => void) | null;
  readonly onClose: () => void;
  readonly onInterruptThread: (threadId: string) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenSubagent: (threadId: string) => void;
  readonly onOpenTurnDetails: (threadId: string, turnId: string) => void;
  readonly parentName: string | null;
  /** The element that opened the drawer; focus returns to it on close (B8). */
  readonly restoreFocus: () => HTMLElement | null;
  readonly snapshot: ThreadStoreSnapshot;
  readonly stoppable: boolean;
  readonly threadId: ThreadId;
}) {
  const t = useT();
  const loadedRef = useRef<string | null>(null);
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId) ?? null;
  const turns = snapshot.turnsByThread.get(threadId) ?? [];
  const threadsById = useMemo(
    () => new Map(snapshot.threads.map((candidate) => [candidate.id, candidate])),
    [snapshot.threads],
  );

  useEffect(() => {
    if (loadedRef.current === threadId) return;
    loadedRef.current = threadId;
    void threadStore.ensureThreadHistory(threadId).catch(() => undefined);
  }, [threadId]);

  const notAvailable = !thread && (snapshot.turnsByThread.get(threadId) === undefined);
  const name = subagentThreadName(thread, t.agent.thread.untitled);
  const running = thread?.status.type === 'active';
  const FormIcon = thread?.source === 'agent.skill' ? SkillIcon : AgentIcon;
  const noop = useCallback(async () => undefined, []);

  return (
    <Dialog
      backdropClassName="subagent-drawer-scrim"
      label={t.agent.thread.subagentDrawer({ name })}
      onBackdropMouseDown={onClose}
      onEscapeKeyDown={onClose}
      restoreFocus={restoreFocus}
      surfaceClassName="subagent-drawer"
    >
      <header className="subagent-drawer-header">
        {onBack ? (
          <IconButton
            icon={BackIcon}
            label={parentName
              ? t.agent.thread.backToParent({ name: parentName })
              : t.agent.thread.backToParentFallback}
            onClick={onBack}
            variant="chrome"
          />
        ) : null}
        <FormIcon aria-hidden className="subagent-drawer-glyph" size={ICON_SIZE.menu} />
        <span className="subagent-drawer-title">{name}</span>
        {running && stoppable ? (
          <IconButton
            icon={StopIcon}
            label={t.agent.thread.stopSubagent({ name })}
            onClick={() => void onInterruptThread(threadId)}
            variant="chrome"
          />
        ) : null}
        <IconButton
          className="subagent-drawer-close"
          icon={CloseIcon}
          label={t.agent.thread.closeSubagent}
          onClick={onClose}
          variant="chrome"
        />
      </header>
      {notAvailable ? (
        <p className="thread-empty-copy">{t.agent.thread.threadUnavailable}</p>
      ) : (
        <ThreadView
          // Read-only by contract: a child is driven by its parent, and user
          // control on it is interrupt-only.
          composerEnabled={false}
          composerFocusToken={0}
          configuration={snapshot.configurationsByThread.get(threadId) ?? null}
          goal={snapshot.goalsByThread.get(threadId) ?? null}
          index={index}
          inputRequest={null}
          key={threadId}
          latestTurnByThread={snapshot.latestTurnByThread}
          onConfigurationChange={noop}
          onContinueInNewChat={noop}
          onCreateThread={async () => false}
          onEditUserMessage={noop}
          onInterrupt={noop}
          onInterruptThread={onInterruptThread}
          onOpenNodeReference={onOpenNodeReference}
          // A grandchild swaps this drawer's contents rather than stacking a
          // second one: delegation is capped at depth 2, so one back is enough.
          onOpenThread={async (target) => onOpenSubagent(target)}
          onOpenTurnDetails={(turn: Turn) => onOpenTurnDetails(threadId, turn.id)}
          onReadToolArguments={(turnId, item) => threadStore.readToolArguments(threadId, turnId, item)}
          onReadToolOutput={(turnId, item) => threadStore.readItemOutput(threadId, turnId, item)}
          onSend={async () => null}
          onSubmitUserInput={noop}
          plan={snapshot.planByThread.get(threadId) ?? null}
          providerRetry={snapshot.providerRetryByThread.get(threadId) ?? null}
          providerSettings={null}
          providerSettingsLoaded
          slashCommands={[]}
          threadCreationBlocked
          threadCreationPending={false}
          threadCwd={thread?.cwd ?? ''}
          threadId={threadId}
          threadModelProvider={thread?.modelProvider ?? ''}
          threadsById={threadsById}
          turns={turns}
          waitingOnUserInput={false}
        />
      )}
      <p className="subagent-drawer-note">{t.agent.thread.subagentReadOnly}</p>
    </Dialog>
  );
}

function subagentThreadName(thread: Thread | null, fallback: string): string {
  return thread?.name || thread?.agentNickname || thread?.preview || fallback;
}
