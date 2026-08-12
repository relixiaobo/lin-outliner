import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RendererUserViewHints, Thread, ThreadId, Turn } from '../../../core/agent/protocol';
import type { DocumentIndex } from '../../state/document';
import { useT } from '../../i18n/I18nProvider';
import { AgentIcon, BackIcon, ICON_SIZE, SkillIcon, StopIcon } from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import {
  consumeSubagentDrill,
  descendantDrillPath,
  subscribeSubagentDrill,
} from '../store/subagentDrillIntent';
import { threadStore, useThreadStore } from '../store/threadStore';
import { ThreadView } from './ThreadView';

/**
 * What a delegated child actually did, opened where it was delegated.
 *
 * A child Thread is an execution artifact of a Turn, so it expands like every
 * other row in the process timeline rather than arriving as a surface of its
 * own. The parent is never covered and never scrolled: there is nothing to
 * navigate back from, because nothing was left.
 *
 * The container's height is FIXED. Delegated work is unbounded — a child can
 * run for minutes and a grandchild longer — and letting it push the timeline
 * open would move the reader's place every time they looked at something. One
 * scroll region lives inside; the transcript outside keeps its own.
 *
 * A descendant REPLACES the contents rather than nesting inside them. Nesting
 * would put a scroll region inside a scroll region, which fights the trackpad
 * at the boundary, and would express depth through indentation the reader has
 * to measure. Swapping keeps one viewport and says the depth out loud, in a
 * header that names the immediate way back. Delegation is capped at depth three;
 * the stack walks d1 -> d2 -> d3 in this one container, and Back unwinds it one
 * depth at a time.
 */
export function SubagentRunDetail({
  index,
  onInterruptThread,
  onOpenNodeReference,
  onOpenThread,
  onOpenTurnDetails,
  rootThreadId,
  userView,
}: {
  readonly index: DocumentIndex;
  readonly onInterruptThread?: (threadId: string) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: ThreadId) => Promise<void>;
  readonly onOpenTurnDetails?: (threadId: string, turnId: string) => void;
  readonly rootThreadId: ThreadId;
  readonly userView: RendererUserViewHints;
}) {
  const t = useT();
  const snapshot = useThreadStore();
  // A request from Thread Details names a child deeper than this row; the path
  // it carried is this container's state, consumed once — on mount if the row
  // opened for it, and on arrival if the row was already open.
  const [stack, setStack] = useState<readonly ThreadId[]>(
    () => consumeSubagentDrill(rootThreadId) ?? [rootThreadId],
  );
  const loadedRef = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const threadId = stack[stack.length - 1] ?? rootThreadId;
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId) ?? null;
  const outer = stack.length > 1
    ? snapshot.threads.find((candidate) => candidate.id === stack[stack.length - 2]) ?? null
    : null;
  const threadsById = useMemo(
    () => new Map(snapshot.threads.map((candidate) => [candidate.id, candidate])),
    [snapshot.threads],
  );

  useEffect(() => subscribeSubagentDrill(() => {
    const path = consumeSubagentDrill(rootThreadId);
    if (path) setStack(path);
  }), [rootThreadId]);

  useEffect(() => {
    if (loadedRef.current === threadId) return;
    loadedRef.current = threadId;
    setLoadError(null);
    // Reported, not swallowed: the load is what fills the container, so a
    // rejection that only cleared a flag would leave "Loading…" on screen for
    // good, with the unavailable state it was written for unreachable.
    void threadStore.ensureThreadHistory(threadId).catch((error: unknown) => {
      if (loadedRef.current !== threadId) return;
      loadedRef.current = null;
      setLoadError(errorMessage(error));
    });
  }, [threadId]);

  const openRelatedThread = useCallback(async (target: ThreadId) => {
    const path = descendantDrillPath(threadId, target, threadsById);
    if (path === null) {
      await onOpenThread(target);
      return;
    }
    if (path.length === 0) return;
    setStack((current) => (
      current[current.length - 1] === threadId ? [...current, ...path] : current
    ));
  }, [onOpenThread, threadId, threadsById]);

  const turns = snapshot.turnsByThread.get(threadId);
  const name = subagentName(thread, t.agent.thread.untitled);
  const FormIcon = thread?.source === 'agent.skill' ? SkillIcon : AgentIcon;
  const agentComposerEnabled = thread?.source === 'collaboration';
  const running = thread?.status.type === 'active';

  return (
    <div className="thread-subagent-detail">
      <header className="thread-subagent-detail-header">
        {/* The crumb, not a bare arrow: drilling replaces what is on screen, so
            the header has to keep saying where you came from — otherwise the
            swap reads as a jump with nothing left to orient against. */}
        {outer ? (
          <>
            <button
              className="thread-subagent-detail-crumb"
              onClick={() => setStack((current) => current.slice(0, -1))}
              type="button"
            >
              <BackIcon aria-hidden size={ICON_SIZE.rowGlyph} />
              <span>{subagentName(outer, t.agent.thread.untitled)}</span>
            </button>
            <span aria-hidden className="thread-subagent-detail-crumb-separator">/</span>
          </>
        ) : null}
        <FormIcon aria-hidden className="thread-subagent-detail-glyph" size={ICON_SIZE.rowGlyph} />
        <span className="thread-subagent-detail-title">{name}</span>
        {running && onInterruptThread ? (
          <IconButton
            icon={StopIcon}
            iconSize={ICON_SIZE.tiny}
            label={t.agent.thread.stopSubagent({ name })}
            onClick={() => void onInterruptThread(threadId)}
            variant="message"
          />
        ) : null}
      </header>
      {loadError !== null ? (
        <p className="thread-subagent-detail-empty" role="alert">{loadError}</p>
      ) : thread === null && turns === undefined ? (
        <p className="thread-subagent-detail-empty">{t.agent.thread.loading}</p>
      ) : thread === null ? (
        <p className="thread-subagent-detail-empty">{t.agent.thread.threadUnavailable}</p>
      ) : turns === undefined ? (
        <p className="thread-subagent-detail-empty">{t.agent.thread.loading}</p>
      ) : (
        <div className="thread-subagent-detail-body" key={threadId}>
          <ThreadView
            composerEnabled={agentComposerEnabled}
            composerFocusToken={0}
            configuration={null}
            goal={snapshot.goalsByThread.get(threadId) ?? null}
            index={index}
            inputRequest={null}
            key={threadId}
            latestTurnByThread={snapshot.latestTurnByThread}
            onConfigurationChange={noop}
            onContinueInNewChat={noop}
            onCreateThread={noFallback}
            onEditUserMessage={noop}
            onInterrupt={() => threadStore.interruptThread(threadId)}
            {...(onInterruptThread ? { onInterruptThread } : { onInterruptThread: noop })}
            onOpenNodeReference={onOpenNodeReference}
            // Descendants swap this container. A sibling link from
            // agent_message returns to the root navigation path instead of
            // inventing a parent-child crumb between peers.
            onOpenThread={openRelatedThread}
            onSubagentDrill={(target) => { void openRelatedThread(target); }}
            onOpenTurnDetails={(turn: Turn) => onOpenTurnDetails?.(threadId, turn.id)}
            onReadToolArguments={(turnId, item) => threadStore.readToolArguments(threadId, turnId, item)}
            onReadToolOutput={(turnId, item) => threadStore.readItemOutput(threadId, turnId, item)}
            onSend={(content) => threadStore.sendToThread(threadId, content, userView)}
            onSubmitUserInput={noop}
            plan={snapshot.planByThread.get(threadId) ?? null}
            providerRetry={snapshot.providerRetryByThread.get(threadId) ?? null}
            providerSettings={null}
            providerSettingsLoaded={false}
            slashCommands={[]}
            threadCreationBlocked
            threadCreationPending={false}
            threadCwd={thread.cwd}
            threadId={threadId}
            threadModelProvider={thread.modelProvider}
            threadsById={threadsById}
            turns={turns}
            userView={userView}
            waitingOnUserInput={false}
          />
        </div>
      )}
      {agentComposerEnabled ? null : (
        <p className="thread-subagent-detail-note">{t.agent.thread.subagentReadOnly}</p>
      )}
    </div>
  );
}

async function noop(): Promise<void> { return undefined; }
async function noFallback(): Promise<boolean> { return false; }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function subagentName(thread: Thread | null, fallback: string): string {
  return thread?.name || thread?.agentNickname || thread?.preview || fallback;
}
