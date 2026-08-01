import { useT } from '../../i18n/I18nProvider';
import { AgentIcon, ICON_SIZE, StopIcon } from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { userFacingAgentError } from '../threadErrorMessage';
import type { SubagentPresentation, SubagentTurnProjection } from '../subagentPresentation';
import { formatSubagentDuration, useSubagentElapsedMs } from './subagentElapsed';

/**
 * What this Turn delegated, while it is still happening.
 *
 * One line per child, in the order the transcript recorded them, replacing the
 * individual activity rows for as long as any of them is alive. It speaks time
 * and status only: the delegation surfaces owe the user no token judgement
 * (Delegation Contract §3), so nothing here — visible text, title, or
 * accessible label — carries one.
 */
export function ThreadDelegationCard({
  onInterruptThread,
  onOpenThread,
  subagents,
}: {
  readonly onInterruptThread: (threadId: string) => Promise<void>;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly subagents: SubagentTurnProjection;
}) {
  const t = useT();
  const lines = [...subagents.byThreadId.values()];
  if (lines.length === 0 || subagents.activeThreadIds.length === 0) return null;
  return (
    <div className="thread-delegation-card">
      <div className="thread-delegation-card-heading">{t.agent.thread.delegationCard}</div>
      <ul className="thread-delegation-lines">
        {lines.map((presentation) => (
          <DelegationLine
            key={presentation.agentThreadId}
            onInterruptThread={onInterruptThread}
            onOpenThread={onOpenThread}
            presentation={presentation}
          />
        ))}
      </ul>
    </div>
  );
}

function DelegationLine({
  onInterruptThread,
  onOpenThread,
  presentation,
}: {
  readonly onInterruptThread: (threadId: string) => Promise<void>;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly presentation: SubagentPresentation;
}) {
  const t = useT();
  const elapsedMs = useSubagentElapsedMs(presentation);
  const status = t.agent.thread.subagentStatuses[presentation.status];
  const statusWithDuration = elapsedMs !== null && elapsedMs >= 1_000
    ? `${status} · ${formatSubagentDuration(elapsedMs)}`
    : status;
  const error = presentation.status === 'errored' && presentation.error
    ? userFacingAgentError(presentation.error, t.agent.thread.resourceLimitReached)
    : null;
  const name = presentation.displayName;
  // Only where there is a Turn to stop: a child that has not started one yet
  // has nothing `turn/interrupt` can address.
  const running = presentation.status === 'running';
  return (
    <li className={`thread-delegation-line thread-subagent-${presentation.status}`}>
      <button
        aria-label={`${t.agent.thread.openSubagentThread({ id: presentation.taskPath ?? name })}. ${statusWithDuration}${error ? `. ${error}` : ''}`}
        className="thread-delegation-line-open"
        onClick={() => void onOpenThread(presentation.agentThreadId)}
        title={error ?? presentation.taskPath ?? name}
        type="button"
      >
        <AgentIcon aria-hidden size={ICON_SIZE.menu} />
        <span className="thread-delegation-line-name">{name}</span>
        <span className="thread-delegation-line-status">{error ?? statusWithDuration}</span>
      </button>
      {running ? (
        <IconButton
          icon={StopIcon}
          iconSize={ICON_SIZE.tiny}
          label={t.agent.thread.stopSubagent({ name })}
          onClick={() => void onInterruptThread(presentation.agentThreadId)}
          variant="message"
        />
      ) : null}
    </li>
  );
}
