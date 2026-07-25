import type { AutomationRun } from '../../../core/agent/automation';
import { useT } from '../../i18n/I18nProvider';
import { OpenIcon, PinIcon } from '../../ui/icons';
import { Button } from '../../ui/primitives/Button';

interface AutomationRunsViewProps {
  readonly automationName: string;
  readonly runs: readonly AutomationRun[];
  readonly onMarkRead: (run: AutomationRun) => Promise<void>;
  readonly onOpenThread: (run: AutomationRun) => Promise<void>;
  readonly onPin: (run: AutomationRun, pinned: boolean) => Promise<void>;
}

export function AutomationRunsView(props: AutomationRunsViewProps) {
  const t = useT().agent.automations;
  if (props.runs.length === 0) return <p className="automation-empty-copy automation-runs-empty">{t.noRuns}</p>;
  return (
    <div className="automation-runs">
      {props.runs.map((run) => {
        const navigable = run.state === 'dispatched' && Boolean(run.threadId);
        return (
          <article className={`automation-run${run.readAt === null ? ' is-unread' : ''}`} key={run.id}>
            <button
              className="automation-run-main"
              disabled={!navigable}
              onClick={() => void props.onOpenThread(run)}
              type="button"
            >
              <span className={`automation-run-state is-${run.state}`} aria-hidden="true" />
              <span className="automation-run-copy">
                <strong>{props.automationName}</strong>
                <small>
                  <span>{t.runStates[run.state]}</span>
                  <span aria-hidden="true"> · </span>
                  <time dateTime={new Date(run.scheduledFor).toISOString()} title={formatDate(run.scheduledFor)}>
                    {formatRelative(run.scheduledFor)}
                  </time>
                </small>
                {run.omission ? <span>{t.omitted({ count: run.omission.count })}</span> : null}
                {run.error ? <span className="automation-run-error">{run.error}</span> : null}
              </span>
              {navigable ? <OpenIcon className="automation-run-open" aria-hidden size={12} /> : null}
            </button>
            <div className="automation-run-actions">
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
        );
      })}
    </div>
  );
}

function formatRelative(timestamp: number): string {
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}
