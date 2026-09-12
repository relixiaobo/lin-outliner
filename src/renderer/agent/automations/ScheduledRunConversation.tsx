import type { RendererUserViewHints } from '../../../core/agent/protocol';
import type { DocumentIndexStore } from '../../state/documentIndexStore';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import { threadStore, useThreadStore } from '../store/threadStore';
import { ThreadView } from '../components/ThreadView';
import { ToolTaskStrip } from '../components/ToolTaskStrip';
import { UserInputRequest } from '../components/UserInputRequest';
import { useT } from '../../i18n/I18nProvider';
import { userInputKey } from '../../../core/agent/userInput';
import { BackIcon } from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { Button } from '../../ui/primitives/Button';
import { useEffect, useMemo } from 'react';
import { MAIN_IDENTITY_KEY } from '../agentIdentity';

export interface ScheduledConversationTarget {
  taskId: string;
  taskName: string;
  runId: string;
  threadId: string;
  turnId: string;
  itemId?: string;
  token: number;
  scheduledFor: number;
  timeZone: string;
}

/** Reads the canonical Thread store; it never changes the selected user chat. */
export function ScheduledRunConversation({ target, active, indexStore, getUserView, onBack, onOpenNode, onOpenThread, onOpenProcess, onDiscuss }: {
  target: ScheduledConversationTarget;
  active: boolean;
  indexStore: DocumentIndexStore;
  getUserView: () => RendererUserViewHints;
  onBack: () => void;
  onOpenNode: ThreadNodeReferenceOpenHandler;
  onOpenThread: (threadId: string) => Promise<void>;
  onOpenProcess: (threadId: string, turnId?: string) => void;
  onDiscuss: () => void;
}) {
  const t = useT();
  const snapshot = useThreadStore(active);
  const thread = snapshot.threads.find((item) => item.id === target.threadId);
  const turns = snapshot.turnsByThread.get(target.threadId) ?? [];
  useEffect(() => { if (active) void threadStore.userInputs.reconcile(target.threadId); }, [active, target.threadId]);
  const pending = snapshot.userInputByThread.get(target.threadId);
  const draft = pending ? snapshot.userInputDrafts.get(userInputKey(pending)) : null;
  const speaker = useMemo(() => ({ participantId: MAIN_IDENTITY_KEY, avatarKey: MAIN_IDENTITY_KEY, name: t.agent.thread.agent.main }), [t]);
  const threadsById = useMemo(() => new Map(snapshot.threads.map((item) => [item.id, item])), [snapshot.threads]);
  return <div className="scheduled-run-conversation" data-run-id={target.runId}>
    <header className="thread-dock-header">
      <IconButton icon={BackIcon} label={t.agent.automations.editor.backToTask} onClick={onBack} />
      <span className="thread-dock-title">{target.taskName}</span>
    </header>
    <p className="scheduled-run-time">{t.agent.automations.editor.runs} · {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: target.timeZone }).format(target.scheduledFor)}</p>
    <div className="scheduled-conversation-actions"><Button size="sm" variant="ghost" onClick={onDiscuss}>{t.agent.automations.work.discuss}</Button>
      <Button size="sm" variant="ghost" onClick={() => onOpenProcess(target.threadId, target.turnId)}>{t.agent.automations.work.process}</Button></div>
    <ToolTaskStrip ownerThreadId={target.threadId} tasks={[...snapshot.toolTasksById.values()].filter((item) => item.ownerThreadId === target.threadId)}
      onRead={(threadId, taskId) => threadStore.readToolTask(threadId, taskId)} onStop={(threadId, taskId) => threadStore.stopToolTask(threadId, taskId)}
      onClearDetails={(threadId) => threadStore.clearToolTaskDetails(threadId)} />
    {thread ? <ThreadView key={`${target.runId}:${target.turnId}:${target.token}`} initialFocus={{ turnId: target.turnId, itemId: target.itemId }}
      active={active} composerEnabled={false} composerFocusExpectedActiveElement={null} composerFocusToken={0}
      indexStore={indexStore} getUserView={getUserView} threadId={thread.id} threadModelProvider={thread.modelProvider}
      threadsById={threadsById} turns={turns} selfSpeaker={speaker} configuration={snapshot.configurationsByThread.get(thread.id) ?? null}
      goal={snapshot.goalsByThread.get(thread.id) ?? null} plan={snapshot.planByThread.get(thread.id) ?? null}
      providerSettings={null} providerSettingsLoaded={true} providerRetry={snapshot.providerRetryByThread.get(thread.id) ?? null}
      slashCommands={[]} inputRequest={pending ?? null} inputDrafts={[...snapshot.userInputDrafts.values()].filter((item) => item.request.threadId === thread.id)}
      waitingOnUserInput={Boolean(pending)} threadCreationBlocked={true} threadCreationPending={false}
      onCreateThread={async () => false} onConfigurationChange={async () => undefined} onSend={async () => null} onEditUserMessage={async () => undefined}
      onReadTurnRecovery={(turn) => threadStore.readTurnRecovery(thread.id, turn.id)}
      onContinueTurn={(turn) => threadStore.continueTurn(thread.id, turn.id)} onRerunTurn={(turn, confirm) => threadStore.rerunTurn(thread.id, turn.id, confirm)}
      onContinueInNewChat={async () => { onDiscuss(); }} onInterrupt={() => threadStore.interrupt(thread.id)}
      onOpenNodeReference={onOpenNode} onOpenThreadReference={onOpenThread} onOpenTurnDetails={(turn) => onOpenProcess(thread.id, turn.id)}
      onReadToolArguments={(turnId, item) => threadStore.readToolArguments(thread.id, turnId, item)} onReadToolOutput={(turnId, item) => threadStore.readItemOutput(thread.id, turnId, item)}
      onSubmitUserInput={(request, answers, intent) => threadStore.respondToUserInput(request, answers, { intent }).then(() => undefined)}
    /> : <p role="status">{t.agent.thread.threadUnavailable}</p>}
    {pending && draft ? <div className="scheduled-conversation-input"><UserInputRequest request={pending} draft={draft}
      onDraftChange={(update) => threadStore.userInputs.updateDraft(pending, update)}
      onExpired={() => { void threadStore.userInputs.reconcile(pending.threadId, true); }}
      onSubmit={(answers, intent) => threadStore.respondToUserInput(pending, answers, { intent }).then(() => undefined)}
      onEditingFinished={() => undefined} /></div> : null}
  </div>;
}
