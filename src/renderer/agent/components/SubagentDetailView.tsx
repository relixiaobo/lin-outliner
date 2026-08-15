import { useCallback, useEffect, useRef, useState } from 'react';
import type { RendererUserViewHints, ThreadId, Turn } from '../../../core/agent/protocol';
import type { DocumentIndexStore } from '../../state/documentIndexStore';
import { useT } from '../../i18n/I18nProvider';
import { BackIcon, GitForkIcon, ICON_SIZE, StopIcon } from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { api } from '../../api/client';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import { threadStore, useThreadStore } from '../store/threadStore';
import { MAIN_AVATAR_IDENTITY } from '../agentAvatarColor';
import { subagentSpeakerName, type SubagentConversationProjection } from '../subagentPresentation';
import { useSubagentActions, useSubagentEntry } from './SubagentRegistryContext';
import { formatSubagentDuration } from './subagentElapsed';
import { ThreadView } from './ThreadView';

/**
 * Everything one Agent did, as a pushed view over the deck.
 *
 * 330px of drawer over a 344px deck is not a drawer, it is a redraw with a
 * seam. Detail is therefore a full-deck push: an anchor pushes it, Back pops
 * it, and the back button names the level below so position in the stack is
 * always legible rather than inferred. Nesting recurses through the same
 * component, and delegation is capped at depth three, so the stack is bounded
 * at four levels by the protocol rather than by a rule of its own.
 *
 * The composer is the physical form of user authority. A message sent here is
 * the top-priority instruction for this Agent, and it is the only action in the
 * app that clears a user stop — which is why a stopped Agent's placeholder says
 * so instead of leaving the rule to documentation.
 */
export function SubagentDetailView({
  agentId,
  indexStore,
  onOpenNodeReference,
  onOpenThread,
  onOpenTurnDetails,
  subagentProjection,
  getUserView,
}: {
  readonly agentId: ThreadId;
  readonly indexStore: DocumentIndexStore;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: ThreadId) => Promise<void>;
  readonly onOpenTurnDetails?: (threadId: string, turnId: string) => void;
  readonly subagentProjection: SubagentConversationProjection;
  readonly getUserView: () => RendererUserViewHints;
}) {
  const t = useT();
  const snapshot = useThreadStore();
  const entry = useSubagentEntry(agentId);
  const actions = useSubagentActions();
  const loadedRef = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const thread = snapshot.threads.find((candidate) => candidate.id === agentId) ?? null;
  const turns = snapshot.turnsByThread.get(agentId);

  useEffect(() => {
    if (loadedRef.current === agentId) return;
    loadedRef.current = agentId;
    setLoadError(null);
    // Reported, not swallowed: this load is what fills the view, so a rejection
    // that only cleared a flag would leave "Loading…" on screen for good.
    void threadStore.ensureThreadHistory(agentId).catch((error: unknown) => {
      if (loadedRef.current !== agentId) return;
      loadedRef.current = null;
      setLoadError(errorMessage(error));
    });
  }, [agentId]);

  // Every anchor opens through the ONE handler that resolves lineage from the
  // conversation: a descendant deepens the stack, while a sibling reached by
  // `agent_message` opens at its own level. Reachability is not lineage, and a
  // stack that grew on reachability alone would draw an edge that never existed.
  const openRelated = useCallback(async (target: ThreadId) => {
    if (subagentProjection.byAgentId.has(target)) {
      actions.openAgent(target);
      return;
    }
    await onOpenThread(target);
  }, [actions, onOpenThread, subagentProjection]);

  // Whose words the host-authored Items here are: the Agent that delegated
  // this one, or the conversation itself when the delegator IS the conversation.
  const parentThreadId = entry?.parentThreadId ?? null;
  const parentEntry = parentThreadId === null
    ? null
    : subagentProjection.byAgentId.get(parentThreadId) ?? null;
  // Named exactly as the conversation names them, so one Agent does not answer
  // to `general-purpose` out there and to its task description in here — the
  // avatar is drawn from that name, so the disc would change letter too.
  //
  // The conversation itself is keyed as `main` rather than by its Thread id,
  // the way every other surface keys it: keyed by id, the one participant that
  // is always there wore a different hue inside a pushed view than it wore in
  // the conversation the reader had just left.
  const hostAuthorName = parentEntry === null
    ? t.agent.thread.agent.main
    : subagentSpeakerName(parentEntry);
  // Only an Agent takes direction. An isolated Skill's result belongs to the
  // `skill` call that invoked it, so there is nothing here for a message to do.
  const composerEnabled = entry?.form !== 'isolatedSkill' && thread?.source === 'collaboration';
  return (
    <div className="thread-agent-detail">
      {loadError !== null ? (
        <p className="thread-agent-detail-empty" role="alert">{loadError}</p>
      ) : thread === null || turns === undefined ? (
        <p className="thread-agent-detail-empty">{t.agent.thread.loading}</p>
      ) : (
        <div className="thread-agent-detail-body" key={agentId}>
          <ThreadView
            active
            composerEnabled={composerEnabled}
            composerFocusToken={0}
            composerPlaceholder={entry?.stoppedByUser
              ? t.agent.thread.agent.composerResumePlaceholder
              : t.agent.thread.agent.composerPlaceholder}
            configuration={null}
            goal={snapshot.goalsByThread.get(agentId) ?? null}
            indexStore={indexStore}
            inputRequest={null}
            key={agentId}
            latestTurnByThread={snapshot.latestTurnByThread}
            onConfigurationChange={noop}
            onContinueInNewChat={noop}
            onCreateThread={noFallback}
            onEditUserMessage={noop}
            onInterrupt={() => threadStore.interruptThread(agentId)}
            onInterruptThread={(target) => threadStore.interruptThread(target)}
            onOpenNodeReference={onOpenNodeReference}
            onOpenThread={openRelated}
            onOpenTurnDetails={(turn: Turn) => onOpenTurnDetails?.(agentId, turn.id)}
            onReadToolArguments={(turnId, item) => threadStore.readToolArguments(agentId, turnId, item)}
            onReadToolOutput={(turnId, item) => threadStore.readItemOutput(agentId, turnId, item)}
            onSend={(content) => threadStore.sendToThread(agentId, content, getUserView())}
            onSubmitUserInput={noop}
            plan={snapshot.planByThread.get(agentId) ?? null}
            providerRetry={snapshot.providerRetryByThread.get(agentId) ?? null}
            providerSettings={null}
            providerSettingsLoaded={false}
            slashCommands={[]}
            agentTranscript
            hostAuthorName={hostAuthorName}
            hostAuthorIdentity={parentEntry === null
              ? MAIN_AVATAR_IDENTITY
              : subagentSpeakerName(parentEntry)}
            selfSpeaker={{
              identity: entry === null ? agentId : subagentSpeakerName(entry),
              name: entry === null ? t.agent.thread.untitled : subagentSpeakerName(entry),
            }}
            subagentProjection={subagentProjection}
            threadCreationBlocked
            threadCreationPending={false}
            threadCwd={thread.cwd}
            threadId={agentId}
            threadModelProvider={thread.modelProvider}
            threadsById={new Map(snapshot.threads.map((candidate) => [candidate.id, candidate]))}
            turns={turns}
            getUserView={getUserView}
            waitingOnUserInput={false}
          />
        </div>
      )}
      {composerEnabled ? null : (
        <p className="thread-agent-detail-note">{t.agent.thread.agent.readOnlySkill}</p>
      )}
      {entry?.worktree ? <SubagentWorktreeFooter agentId={agentId} branch={entry.worktree.branch} /> : null}
    </div>
  );
}

/**
 * The pushed level's title bar: Back, the Agent, and how it is doing.
 *
 * It replaces the conversation's title rather than sitting under it, because a
 * navigation stack that leaves the previous level's title on screen inverts the
 * hierarchy — the loudest line becomes the one thing the reader is not looking
 * at. Back names the level below, so position in the stack stays legible.
 */
export function SubagentDetailTitle({
  agentId,
  onPop,
  parentName,
}: {
  readonly agentId: ThreadId;
  readonly onPop: () => void;
  readonly parentName: string;
}) {
  const t = useT();
  const entry = useSubagentEntry(agentId);
  const name = entry?.displayName ?? t.agent.thread.untitled;
  const running = entry?.status === 'running' || entry?.status === 'pendingInit';
  const badge = entry?.form === 'isolatedSkill'
    ? t.agent.thread.agent.skill
    : entry?.agentType || null;
  return (
    <>
      <button
        aria-label={`${t.agent.thread.agent.back}: ${parentName}`}
        className="thread-dock-title-button"
        onClick={onPop}
        title={parentName}
        type="button"
      >
        <BackIcon className="thread-dock-title-leading" size={ICON_SIZE.menu} />
        <span className="thread-dock-title">{name}</span>
        {/* What kind of Agent this is, as a badge after the name rather than a
            glyph before it: a glyph asks the reader to know an icon, while the
            badge carries the word — and the word is the useful half for the
            specialized types, which are the ones worth telling apart. */}
        {badge ? <span className="thread-agent-title-badge">{badge}</span> : null}
        {entry?.worktree ? (
          <span
            aria-label={t.agent.thread.agent.worktree}
            className="thread-agent-title-worktree"
            role="img"
            title={t.agent.thread.agent.worktree}
          >
            <GitForkIcon aria-hidden size={ICON_SIZE.tiny} />
          </span>
        ) : null}
      </button>
      {running ? (
        <IconButton
          className="thread-dock-surface-action"
          icon={StopIcon}
          iconSize={ICON_SIZE.tiny}
          label={t.agent.thread.stopSubagent({ name })}
          onClick={() => void threadStore.interruptThread(agentId).catch(() => undefined)}
          variant="chrome"
        />
      ) : null}
    </>
  );
}

/**
 * The workspace an Agent left behind.
 *
 * A retained worktree is the one artifact of a delegated run that outlives the
 * conversation and lives outside it, so the footer names the branch, counts
 * what changed, and hands the user the two things they can actually do with a
 * directory: look at what is in it, and open it. Tenon has no diff viewer, so
 * "view changes" lists the changed paths rather than pretending to be one.
 */
function SubagentWorktreeFooter({
  agentId,
  branch,
}: {
  readonly agentId: ThreadId;
  readonly branch: string;
}) {
  const t = useT();
  const [changes, setChanges] = useState<readonly string[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setChanges(null);
    setUnavailable(false);
    // A failed count is not evidence the worktree is gone: the branch is still
    // recorded and revealing it may still work, so the footer keeps its
    // branch-only form rather than claiming a loss it has not observed.
    void api.readAgentWorktreeChanges(agentId).then((result) => {
      if (!cancelled && result.available) setChanges(result.paths);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [agentId]);

  return (
    <footer className="thread-agent-worktree">
      <div className="thread-agent-worktree-line">
        <GitForkIcon aria-hidden size={ICON_SIZE.tiny} />
        <span className="thread-agent-worktree-branch">
          {changes === null
            ? t.agent.thread.agent.worktreeFooterUnknown({ branch })
            : t.agent.thread.agent.worktreeFooter({ branch, count: changes.length })}
        </span>
        {changes !== null && changes.length > 0 ? (
          <button
            className="thread-agent-worktree-action"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            {expanded ? t.agent.thread.agent.hideChanges : t.agent.thread.agent.viewChanges}
          </button>
        ) : null}
        <button
          className="thread-agent-worktree-action"
          onClick={() => void api.revealAgentWorktree(agentId).then((result) => {
            if (!result.revealed) setUnavailable(true);
          })}
          type="button"
        >
          {t.agent.thread.agent.revealWorktree}
        </button>
      </div>
      {unavailable ? (
        <p className="thread-agent-worktree-note" role="alert">
          {t.agent.thread.agent.worktreeUnavailable}
        </p>
      ) : null}
      {expanded && changes !== null ? (
        <ul className="thread-agent-worktree-changes">
          {changes.map((path) => <li key={path}><code>{path}</code></li>)}
        </ul>
      ) : null}
    </footer>
  );
}

async function noop(): Promise<void> { return undefined; }
async function noFallback(): Promise<boolean> { return false; }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
