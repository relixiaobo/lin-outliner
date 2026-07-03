import type { KeyboardEvent, ReactNode } from 'react';
import type { AgentObjectiveStatus } from '../../../core/agentEventLog';
import type { Messages } from '../../../core/i18n';
import type { AgentRenderRunStatus } from '../../../core/agentRenderProjection';
import { useT } from '../../i18n/I18nProvider';
import {
  ClockIcon,
  ChevronRightIcon,
  ICON_SIZE,
  LoaderIcon,
  RunSpawnToolIcon,
  StopIcon,
  ToolErrorIcon,
  type AppIcon,
} from '../icons';
import { CheckboxMark } from '../primitives/CheckboxMark';
import { formatRunDuration } from './agentProcessTypes';

export type AgentRunDisplayStatus = AgentRenderRunStatus | AgentObjectiveStatus;

export interface AgentRunRowData {
  runId: string;
  title: string;
  status: AgentRenderRunStatus;
  objectiveStatus?: AgentObjectiveStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  childRunCount?: number;
  completedChildRunCount?: number;
  blockedReason?: string;
  error?: string;
}

interface AgentRunRowProps {
  action?: ReactNode;
  className?: string;
  onOpen?: () => void;
  run: AgentRunRowData;
  showSummary?: boolean;
}

export function displayRunStatus(run: Pick<AgentRunRowData, 'objectiveStatus' | 'status'>): AgentRunDisplayStatus {
  if (
    run.objectiveStatus
    && run.objectiveStatus !== 'active'
    && run.objectiveStatus !== 'stopped'
  ) {
    return run.objectiveStatus;
  }
  return run.status;
}

export function runStatusClass(status: AgentRunDisplayStatus): string {
  return status.replace(/_/g, '-');
}

export function isCompletedRunStatus(status: AgentRunDisplayStatus): boolean {
  return status === 'completed' || status === 'verified';
}

function runStatusIcon(status: AgentRunDisplayStatus): AppIcon {
  if (status === 'running' || status === 'active' || status === 'verifying') return LoaderIcon;
  if (status === 'stopped') return StopIcon;
  if (status === 'blocked' || status === 'budget_exhausted' || status === 'failed') return ToolErrorIcon;
  return ClockIcon;
}

export function runStatusLabel(status: AgentRunDisplayStatus, labels: Messages['agent']['run']['status']): string {
  if (status === 'budget_exhausted') return labels.budgetExhausted;
  if (status === 'blocked') return labels.blocked;
  if (status === 'verified') return labels.verified;
  if (status === 'verifying') return labels.verifying;
  if (status === 'running' || status === 'active') return labels.running;
  if (status === 'failed') return labels.failed;
  if (status === 'stopped') return labels.stopped;
  return labels.completed;
}

export function runWorkLabel(
  run: Pick<AgentRunRowData, 'completedAt' | 'startedAt' | 'status' | 'updatedAt'>,
  labels: Messages['agent']['process'],
): string {
  if (run.status === 'running') {
    const duration = Date.now() - run.startedAt;
    return duration >= 1000
      ? labels.workingFor({ duration: formatRunDuration(duration) })
      : labels.working;
  }
  const duration = formatRunDuration((run.completedAt ?? run.updatedAt) - run.startedAt);
  if (run.status === 'stopped') return labels.stoppedAfter({ duration });
  return labels.workedFor({ duration });
}

function relativeRunTimeLabel(timestamp: number, labels: Messages['agent']['run']): string {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  if (deltaMs < 60_000) return labels.relativeJustNow;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return labels.relativeMinutesAgo({ count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return labels.relativeHoursAgo({ count: hours });
  return labels.relativeDaysAgo({ count: Math.floor(hours / 24) });
}

function completedRunSummary(run: AgentRunRowData, labels: Messages['agent']['run']): string {
  const duration = formatRunDuration((run.completedAt ?? run.updatedAt) - run.startedAt);
  const completedAt = run.completedAt ?? run.updatedAt;
  return `${relativeRunTimeLabel(completedAt, labels)} · ${duration}`;
}

function runSummary(run: AgentRunRowData, status: AgentRunDisplayStatus, t: Messages): string {
  if (status === 'blocked' && run.blockedReason) return `${t.agent.run.status.blocked}: ${run.blockedReason}`;
  if (status === 'failed' && run.error) return `${t.agent.run.status.failed}: ${run.error}`;
  if (status === 'budget_exhausted' && run.blockedReason) {
    return `${t.agent.run.status.budgetExhausted}: ${run.blockedReason}`;
  }
  if (status === 'blocked' || status === 'failed' || status === 'budget_exhausted' || status === 'verifying') {
    return runStatusLabel(status, t.agent.run.status);
  }
  if (isCompletedRunStatus(status)) return completedRunSummary(run, t.agent.run);
  return runWorkLabel(run, t.agent.process);
}

function openFromKeyboard(event: KeyboardEvent<HTMLElement>, onOpen: (() => void) | undefined) {
  if (!onOpen || event.currentTarget !== event.target) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onOpen();
}

export function AgentRunStatusMarker({
  className,
  status,
}: {
  className?: string;
  status: AgentRunDisplayStatus;
}) {
  const statusClass = runStatusClass(status);
  const StatusIcon = runStatusIcon(status);
  const completedStatus = isCompletedRunStatus(status);
  return (
    <span className={['agent-run-marker', `is-${statusClass}`, className ?? ''].filter(Boolean).join(' ')} aria-hidden="true">
      {completedStatus ? (
        <CheckboxMark checked />
      ) : (
        <StatusIcon
          className={status === 'running' || status === 'active' || status === 'verifying'
            ? 'agent-run-status-spinner'
            : undefined}
          size={ICON_SIZE.menu}
          strokeWidth={2.4}
        />
      )}
    </span>
  );
}

export function AgentRunRow({ action, className, onOpen, run, showSummary = true }: AgentRunRowProps) {
  const t = useT();
  const status = displayRunStatus(run);
  const statusClass = runStatusClass(status);
  const childRunCount = run.childRunCount ?? 0;
  const completedChildRunCount = run.completedChildRunCount ?? 0;
  const childProgressLabel = childRunCount > 0
    ? t.agent.run.subRunProgress({ completed: completedChildRunCount, total: childRunCount })
    : null;
  const summary = showSummary ? runSummary(run, status, t) : null;
  const rowClassName = [
    'agent-run-row',
    `is-${run.status}`,
    `is-${statusClass}`,
    childRunCount > 0 ? 'has-children' : 'is-leaf',
    action ? 'has-actions' : '',
    onOpen ? 'is-clickable' : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  return (
    <article
      aria-label={[run.title, childProgressLabel, summary].filter(Boolean).join(', ')}
      className={rowClassName}
      onClick={onOpen}
      onKeyDown={(event) => openFromKeyboard(event, onOpen)}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <AgentRunStatusMarker status={status} />
      <div className="agent-run-main">
        <div className="agent-run-title-row">
          <span className="agent-run-title" title={run.title}>{run.title}</span>
        </div>
        {childProgressLabel || summary ? (
          <div className="agent-run-meta-row">
            {childProgressLabel ? (
              <span className="agent-run-branch-chip" aria-label={childProgressLabel} title={childProgressLabel}>
                <RunSpawnToolIcon size={ICON_SIZE.menu} />
                <span>{completedChildRunCount}/{childRunCount}</span>
              </span>
            ) : null}
            {summary ? <span className="agent-run-meta-chip" title={summary}>{summary}</span> : null}
          </div>
        ) : null}
      </div>
      {onOpen ? (
        <span className="agent-run-open-affordance" aria-hidden="true">
          <ChevronRightIcon size={ICON_SIZE.rowChevron} strokeWidth={2} />
        </span>
      ) : null}
      {action ? (
        <div className="agent-run-row-actions">
          {action}
        </div>
      ) : null}
    </article>
  );
}
