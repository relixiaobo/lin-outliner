import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Activity,
  AgentIssue,
  AgentRecurringIssue,
  AgentSession,
  IssueReadResult,
  IssueSearchInput,
  IssueSearchRow,
  IssueTargetRef,
} from '../../api/types';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import {
  CheckIcon,
  CalendarIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  ICON_SIZE,
  LoaderIcon,
  WarningIcon,
} from '../icons';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
import { ButtonControl } from '../primitives/ButtonControl';

export type IssueWorkPreset = 'triage' | 'active' | 'scheduled' | 'completed' | 'activity';

interface AgentIssuesPanelProps {
  activeSessionCount: number;
  error: string | null;
  loading: boolean;
  onOpenIssue: (target: IssueTargetRef) => void;
  onPresetChange: (preset: IssueWorkPreset) => void;
  onRefresh: () => void;
  preset: IssueWorkPreset;
  rows: readonly IssueSearchRow[];
}

interface AgentIssueDetailsPanelProps {
  onClose: () => void;
  target: IssueTargetRef;
}

const ISSUE_DETAIL_INCLUDE = ['activity', 'sessions', 'sub-issues', 'generated-issues', 'criteria'] as const;

export function issueSearchInputForWorkPreset(preset: IssueWorkPreset): IssueSearchInput {
  switch (preset) {
    case 'triage':
      return { filter: { archived: false, confirmed: false }, limit: 100 };
    case 'active':
      return {
        targets: ['issue'],
        filter: {
          archived: false,
          statusCategories: ['triage', 'unstarted', 'started', 'blocked', 'attention-needed'],
        },
        limit: 100,
      };
    case 'scheduled':
      return { filter: { archived: false, statusCategories: ['scheduled'] }, limit: 100 };
    case 'completed':
      return {
        targets: ['issue'],
        filter: { archived: false, statusCategories: ['completed', 'canceled'] },
        limit: 100,
      };
    case 'activity':
      return { filter: { archived: false }, limit: 100 };
  }
}

function targetKey(target: IssueTargetRef): string {
  return `${target.type}:${target.id}`;
}

function relativeTimeLabel(timestamp: number, labels: ReturnType<typeof useT>['agent']['run']): string {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  if (deltaMs < 60_000) return labels.relativeJustNow;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return labels.relativeMinutesAgo({ count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return labels.relativeHoursAgo({ count: hours });
  return labels.relativeDaysAgo({ count: Math.floor(hours / 24) });
}

function targetKindLabel(target: IssueTargetRef, labels: ReturnType<typeof useT>['agent']['issue']): string {
  return target.type === 'recurring-issue' ? labels.recurringIssue : labels.issue;
}

function activityText(activity: Activity): string {
  switch (activity.content.type) {
    case 'comment':
    case 'agent-progress':
    case 'agent-question':
    case 'agent-response':
    case 'agent-error':
      return activity.content.body;
    case 'field-change':
      return `Changed ${activity.content.field}.`;
    case 'status-change':
      return `Status changed to ${activity.content.to}.`;
    case 'agent-action':
      return activity.content.result
        ? `${activity.content.action}: ${activity.content.result}`
        : activity.content.action;
    case 'verification-result':
      return `${activity.content.verdict}: ${activity.content.body}`;
    case 'output-link':
      return activity.content.label;
  }
}

function sessionStateLabel(state: AgentSession['state'], labels: ReturnType<typeof useT>['agent']['issue']): string {
  switch (state) {
    case 'pending':
      return labels.sessionState.pending;
    case 'active':
      return labels.sessionState.active;
    case 'awaitingInput':
      return labels.sessionState.awaitingInput;
    case 'complete':
      return labels.sessionState.complete;
    case 'error':
      return labels.sessionState.error;
    case 'stale':
      return labels.sessionState.stale;
    case 'canceled':
      return labels.sessionState.canceled;
  }
}

function issueTriggerLabel(issue: AgentIssue, labels: ReturnType<typeof useT>['agent']['issue']): string {
  if (issue.trigger.type === 'manual') return labels.triggerManual;
  if (issue.trigger.type === 'when-ready') return labels.triggerWhenReady;
  return labels.triggerScheduled;
}

function cadenceLabel(recurringIssue: AgentRecurringIssue, labels: ReturnType<typeof useT>['agent']['issue']): string {
  switch (recurringIssue.cadence.type) {
    case 'daily':
      return labels.cadenceDaily;
    case 'weekly':
      return labels.cadenceWeekly;
    case 'monthly':
      return labels.cadenceMonthly;
  }
}

function IssueStatusMarker({ row }: { row: IssueSearchRow }) {
  const isRecurring = row.target.type === 'recurring-issue';
  const Icon = isRecurring ? CalendarIcon : row.status.toLowerCase().includes('complete') ? CheckIcon : ClockIcon;
  return (
    <span className={`agent-issue-marker ${isRecurring ? 'is-recurring' : ''}`}>
      <Icon aria-hidden="true" size={ICON_SIZE.menu} />
    </span>
  );
}

export function AgentIssuesPanel({
  activeSessionCount,
  error,
  loading,
  onOpenIssue,
  onPresetChange,
  onRefresh,
  preset,
  rows,
}: AgentIssuesPanelProps) {
  const t = useT();
  const presets: IssueWorkPreset[] = ['triage', 'active', 'scheduled', 'completed', 'activity'];

  return (
    <section className="agent-issue-panel" aria-label={t.agent.issue.panelAriaLabel}>
      <div className="agent-issue-toolbar" role="tablist" aria-label={t.agent.issue.viewsAriaLabel}>
        {presets.map((item) => (
          <ButtonControl
            aria-selected={preset === item}
            className={`agent-issue-view-tab${preset === item ? ' is-selected' : ''}`}
            key={item}
            onClick={() => onPresetChange(item)}
            role="tab"
          >
            {t.agent.issue.view[item]}
          </ButtonControl>
        ))}
      </div>
      {activeSessionCount > 0 ? (
        <div className="agent-issue-active-summary" role="status">
          <LoaderIcon className="agent-run-status-spinner" size={ICON_SIZE.menu} />
          <span>{t.agent.issue.activeSessions({ count: activeSessionCount })}</span>
        </div>
      ) : null}
      {error ? (
        <ErrorState
          className="agent-run-empty"
          message={error}
          onRetry={onRefresh}
          retryLabel={t.agent.issue.refresh}
        />
      ) : loading && rows.length === 0 ? (
        <EmptyState
          className="agent-run-empty"
          icon={LoaderIcon}
          iconClassName="agent-tool-call-spinner"
          loading
          role="status"
          title={t.agent.issue.loading}
        />
      ) : rows.length === 0 ? (
        <div className="agent-run-empty">{t.agent.issue.empty}</div>
      ) : (
        <div className="agent-run-list" aria-label={t.agent.issue.listAriaLabel}>
          {rows.map((row) => (
            <button
              className="agent-run-row agent-issue-row is-clickable"
              key={targetKey(row.target)}
              onClick={() => onOpenIssue(row.target)}
              type="button"
            >
              <IssueStatusMarker row={row} />
              <span className="agent-run-main">
                <span className="agent-run-title-row">
                  <span className="agent-run-title">{row.title}</span>
                </span>
                <span className="agent-run-summary">
                  {targetKindLabel(row.target, t.agent.issue)} · {row.status} · {relativeTimeLabel(row.updatedAt, t.agent.run)}
                </span>
              </span>
              <ChevronRightIcon className="agent-run-open-affordance" size={ICON_SIZE.menu} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function AgentIssueDetailsPanel({ onClose, target }: AgentIssueDetailsPanelProps) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<IssueReadResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await api.agentIssueRead({ target, include: [...ISSUE_DETAIL_INCLUDE] }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    void load();
  }, [load]);

  const issue = detail?.issue;
  const recurringIssue = detail?.recurringIssue;
  const title = issue?.title ?? recurringIssue?.titleTemplate ?? t.agent.issue.unknown;
  const status = issue?.status.name ?? recurringIssue?.status ?? '';
  const activity = useMemo(() => [...(detail?.activity ?? [])].sort((left, right) => right.createdAt - left.createdAt), [detail?.activity]);
  const sessions = useMemo(() => [...(detail?.sessions ?? [])].sort((left, right) => right.updatedAt - left.updatedAt), [detail?.sessions]);

  return (
    <section className="agent-run-detail-panel agent-issue-detail-panel" aria-label={t.agent.issueDetail.detailsAriaLabel}>
      <header className="agent-run-detail-header">
        <div className="agent-run-detail-breadcrumb-row">
          <span className="agent-run-detail-breadcrumb-root">{t.agent.issue.heading}</span>
          <div className="agent-run-detail-header-actions">
            <IconButton
              className="agent-run-detail-close"
              icon={CloseIcon}
              label={t.agent.issueDetail.close}
              onClick={onClose}
              title={t.agent.issueDetail.close}
              variant="message"
            />
          </div>
        </div>
      </header>
      <div className="agent-run-detail-body">
        {error ? (
          <ErrorState
            className="agent-run-detail-empty"
            message={error}
            onRetry={() => void load()}
            retryLabel={t.agent.issue.refresh}
          />
        ) : loading && !detail ? (
          <EmptyState
            className="agent-run-detail-empty"
            icon={LoaderIcon}
            loading
            title={t.agent.issue.loading}
          />
        ) : (
          <>
            <div className="agent-run-detail-title-line">
              <span className="agent-issue-detail-marker">
                {target.type === 'recurring-issue'
                  ? <CalendarIcon aria-hidden="true" size={ICON_SIZE.menu} />
                  : <ClockIcon aria-hidden="true" size={ICON_SIZE.menu} />}
              </span>
              <h3>{title}</h3>
            </div>
            <div className="agent-run-detail-content-column">
              <dl className="agent-run-detail-metadata">
                <div>
                  <dt>{t.agent.issueDetail.type}</dt>
                  <dd>{targetKindLabel(target, t.agent.issue)}</dd>
                </div>
                <div>
                  <dt>{t.agent.issueDetail.status}</dt>
                  <dd>{status || t.agent.issueDetail.none}</dd>
                </div>
                {issue ? (
                  <div>
                    <dt>{t.agent.issueDetail.trigger}</dt>
                    <dd>{issueTriggerLabel(issue, t.agent.issue)}</dd>
                  </div>
                ) : null}
                {recurringIssue ? (
                  <div>
                    <dt>{t.agent.issueDetail.cadence}</dt>
                    <dd>{cadenceLabel(recurringIssue, t.agent.issue)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t.agent.issueDetail.confirmation}</dt>
                  <dd>{(issue?.confirmation ?? recurringIssue?.confirmation)?.state ?? t.agent.issueDetail.none}</dd>
                </div>
              </dl>
              {issue?.description || recurringIssue?.descriptionTemplate ? (
                <div className="agent-issue-detail-description">
                  {issue?.description ?? recurringIssue?.descriptionTemplate}
                </div>
              ) : null}
              {sessions.length > 0 ? (
                <section className="agent-issue-detail-section">
                  <h4>{t.agent.issueDetail.sessions}</h4>
                  <div className="agent-issue-session-list">
                    {sessions.map((session) => (
                      <div className="agent-issue-session-row" key={session.id}>
                        <div className="agent-issue-session-head">
                          <span>{sessionStateLabel(session.state, t.agent.issue)}</span>
                          <span>{relativeTimeLabel(session.updatedAt, t.agent.run)}</span>
                        </div>
                        {session.latestOutput ? <p>{session.latestOutput}</p> : null}
                        {session.errorMessage ? (
                          <p className="agent-issue-session-error">
                            <WarningIcon size={ICON_SIZE.menu} />
                            <span>{session.errorMessage}</span>
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              {detail?.subIssues?.length ? (
                <section className="agent-issue-detail-section">
                  <h4>{t.agent.issueDetail.subIssues}</h4>
                  <ul className="agent-issue-detail-list">
                    {detail.subIssues.map((subIssue) => (
                      <li key={subIssue.id}>{subIssue.title}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {detail?.generatedIssues?.length ? (
                <section className="agent-issue-detail-section">
                  <h4>{t.agent.issueDetail.generatedIssues}</h4>
                  <ul className="agent-issue-detail-list">
                    {detail.generatedIssues.map((generatedIssue) => (
                      <li key={generatedIssue.id}>{generatedIssue.title}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section className="agent-issue-detail-section">
                <h4>{t.agent.issueDetail.activity}</h4>
                {activity.length === 0 ? (
                  <div className="agent-issue-activity-empty">{t.agent.issueDetail.noActivity}</div>
                ) : (
                  <ol className="agent-issue-activity-list">
                    {activity.map((entry) => (
                      <li key={entry.id}>
                        <span>{activityText(entry)}</span>
                        <time>{relativeTimeLabel(entry.createdAt, t.agent.run)}</time>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
