import type { AutomationRun } from '../../../core/agent/automation';
import { useT } from '../../i18n/I18nProvider';
import { OpenIcon, PinIcon } from '../../ui/icons';
import { Button } from '../../ui/primitives/Button';

interface AutomationRunsViewProps {
  readonly runs: readonly AutomationRun[];
  readonly onMarkRead: (run: AutomationRun) => Promise<void>;
  readonly onOpenThread: (run: AutomationRun) => Promise<void>;
  readonly onPin: (run: AutomationRun, pinned: boolean) => Promise<void>;
}

export function AutomationRunsView(props: AutomationRunsViewProps) {
  const t = useT().agent.automations;
  if (props.runs.length === 0) return <p className="automation-empty-copy">{t.noRuns}</p>;
  return (
    <div className="automation-runs">
      {props.runs.map((run) => (
        <article className={`automation-run${run.readAt === null ? ' is-unread' : ''}`} key={run.id}>
          <div className="automation-run-heading">
            <span className={`automation-run-state is-${run.state}`}>{t.runStates[run.state]}</span>
            <time dateTime={new Date(run.scheduledFor).toISOString()}>{formatDate(run.scheduledFor)}</time>
          </div>
          {run.omission ? <p>{t.omitted({ count: run.omission.count })}</p> : null}
          {run.error ? <p className="automation-run-error">{run.error}</p> : null}
          <div className="automation-run-actions">
            {run.state === 'dispatched' && run.threadId ? (
              <Button onClick={() => void props.onOpenThread(run)} size="sm" variant="ghost">
                <OpenIcon size={12} />{t.openThread}
              </Button>
            ) : null}
            {run.readAt === null && (run.state === 'dispatched' || run.state === 'failed') ? (
              <Button onClick={() => void props.onMarkRead(run)} size="sm" variant="ghost">{t.markRead}</Button>
            ) : null}
            {run.worktree?.removedAt === null ? (
              <Button onClick={() => void props.onPin(run, !run.pinned)} size="sm" variant="ghost">
                <PinIcon size={12} />{run.pinned ? t.unpin : t.pin}
              </Button>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}
