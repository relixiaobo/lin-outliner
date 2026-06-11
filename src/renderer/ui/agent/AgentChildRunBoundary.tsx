import { useState } from 'react';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { AgentChildRunEntry } from '../../agent/runtime';
import type { Messages } from '../../../core/i18n';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CommandIcon,
  ICON_SIZE,
  LoaderIcon,
} from '../icons';
import { AgentMarkdown } from './AgentMarkdown';
import { useT } from '../../i18n/I18nProvider';

type BoundaryLabels = Messages['agent']['childRun']['boundary'];

function clockLabel(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function statusLabel(childRun: AgentRenderChildRunEntity, labels: BoundaryLabels): string {
  if (childRun.status === 'running') return labels.running;
  if (childRun.status === 'failed') return labels.failed;
  if (childRun.status === 'stopped') return labels.stopped;
  return labels.ranAt({ time: clockLabel(childRun.completedAt ?? childRun.updatedAt) });
}

// The inline transcript divider for a child run — the conversation's permanent
// record of the run (its final result, expandable). Mirrors the compaction/dream
// boundaries: a centered control between two rules, expanding to the result with a
// link into the full run. Used for both a parentless command fire and a
// main-agent-spawned child run (which replaces its tool-call block).
export function AgentChildRunBoundary({
  entry,
  onOpenTranscript,
}: {
  entry: AgentChildRunEntry;
  onOpenTranscript?: (childRunId: string) => void;
}) {
  const t = useT();
  const labels = t.agent.childRun.boundary;
  const childRun = entry.childRun;
  const [expanded, setExpanded] = useState(false);

  const running = childRun.status === 'running';
  const isError = childRun.status === 'failed' || childRun.status === 'stopped';
  const description = childRun.description.trim() || childRun.name?.trim() || childRun.agentType;
  const body = (childRun.error ?? '').trim() || (childRun.result ?? '').trim();
  // The transcript is the child run's own ledger — always addressable by run id.
  const canOpen = Boolean(onOpenTranscript);

  return (
    <section className="agent-child-run-boundary" aria-label={`${labels.label} · ${description}`}>
      <div className="agent-child-run-line" aria-hidden="true" />
      <div className="agent-child-run-controls">
        {running ? (
          <div className="agent-child-run-toggle is-active" role="status">
            <LoaderIcon className="agent-tool-call-spinner" size={ICON_SIZE.tiny} />
            <CommandIcon size={ICON_SIZE.tiny} />
            <span>{labels.label}</span>
            <small className="agent-child-run-desc">{description}</small>
            <small>{labels.running}</small>
          </div>
        ) : (
          <button
            aria-expanded={expanded}
            className="agent-child-run-toggle"
            type="button"
            onClick={() => setExpanded((open) => !open)}
          >
            <ChevronDownIcon
              className={expanded ? 'agent-child-run-chevron is-expanded' : 'agent-child-run-chevron'}
              size={ICON_SIZE.tiny}
            />
            <CommandIcon size={ICON_SIZE.tiny} />
            <span>{labels.label}</span>
            <small className="agent-child-run-desc">{description}</small>
            <small className={isError ? 'is-error' : ''}>{statusLabel(childRun, labels)}</small>
          </button>
        )}
      </div>
      <div className="agent-child-run-line" aria-hidden="true" />
      {expanded ? (
        <div className="agent-child-run-summary">
          {body ? (
            <AgentMarkdown keyPrefix={`child-run-${childRun.id}`} text={body} />
          ) : (
            <p className="agent-child-run-empty">{labels.noResult}</p>
          )}
          {canOpen ? (
            <button
              className="agent-child-run-open"
              type="button"
              onClick={() => onOpenTranscript?.(childRun.id)}
            >
              <span>{labels.viewFullRun}</span>
              <ChevronRightIcon size={ICON_SIZE.tiny} />
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
