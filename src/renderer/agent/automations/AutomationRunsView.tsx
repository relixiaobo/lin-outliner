import type { AutomationRun } from '../../../core/agent/automation';
import { useT } from '../../i18n/I18nProvider';
import { OpenIcon, PinIcon } from '../../ui/icons';
import { Button } from '../../ui/primitives/Button';

interface AutomationRunsViewProps {
  readonly automationName: string;
  readonly busy: boolean;
  readonly hasUnread: boolean;
  readonly runs: readonly AutomationRun[];
  readonly onMarkAllRead: () => Promise<void>;
  readonly onOpenThread: (run: AutomationRun) => Promise<void>;
  readonly onPin: (run: AutomationRun, pinned: boolean) => Promise<void>;
}

export function AutomationRunsView(props: AutomationRunsViewProps) {
  const t = useT().agent.automations;
  return (
    <>
      <div className="automation-runs-header">
        <h3>{t.previousRuns}</h3>
        {props.hasUnread ? (
          <Button
            disabled={props.busy}
            onClick={() => void props.onMarkAllRead()}
            size="sm"
            variant="ghost"
          >
            {t.markAllRead}
          </Button>
        ) : null}
      </div>
      {props.runs.length === 0 ? (
        <p className="automation-empty-copy automation-runs-empty">{t.noRuns}</p>
      ) : (
        <div className="automation-runs">
          {props.runs.map((run) => {
            const navigable = run.state === 'dispatched' && Boolean(run.threadId);
            const unread = isUnread(run);
            return (
              <article className={`automation-run${unread ? ' is-unread' : ''}`} key={run.id}>
                <button
                  aria-label={unread ? `${props.automationName}, ${t.unread}` : undefined}
                  className="automation-run-main"
                  disabled={!navigable}
                  onClick={() => void props.onOpenThread(run)}
                  type="button"
                >
                  <span
                    className={`automation-run-unread${unread ? ' is-visible' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="automation-run-copy">
                    <strong>{props.automationName}</strong>
                    <small>
                      <span className={`automation-run-status is-${run.state}`}>{t.runStates[run.state]}</span>
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
                {run.worktree?.removedAt === null ? (
                  <div className="automation-run-actions">
                    <Button onClick={() => void props.onPin(run, !run.pinned)} size="sm" variant="ghost">
                      <PinIcon size={12} />{run.pinned ? t.unpin : t.pin}
                    </Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

function isUnread(run: AutomationRun): boolean {
  return run.readAt === null && (run.state === 'dispatched' || run.state === 'failed');
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
