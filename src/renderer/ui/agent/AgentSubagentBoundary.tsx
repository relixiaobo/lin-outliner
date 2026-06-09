import { useState } from 'react';
import type { AgentRenderSubagentEntity } from '../../../core/agentRenderProjection';
import type { AgentSubagentEntry } from '../../agent/runtime';
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

type BoundaryLabels = Messages['agent']['subagent']['boundary'];

function clockLabel(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function statusLabel(subagent: AgentRenderSubagentEntity, labels: BoundaryLabels): string {
  if (subagent.status === 'running') return labels.running;
  if (subagent.status === 'failed') return labels.failed;
  if (subagent.status === 'stopped') return labels.stopped;
  return labels.ranAt({ time: clockLabel(subagent.completedAt ?? subagent.updatedAt) });
}

// The inline transcript divider for a subagent run — the conversation's permanent
// record of the run (its final result, expandable). Mirrors the compaction/dream
// boundaries: a centered control between two rules, expanding to the result with a
// link into the full run. Used for both a parentless command fire and a
// main-agent-spawned subagent (which replaces its tool-call block).
export function AgentSubagentBoundary({
  entry,
  onOpenTranscript,
}: {
  entry: AgentSubagentEntry;
  onOpenTranscript?: (subagentId: string) => void;
}) {
  const t = useT();
  const labels = t.agent.subagent.boundary;
  const subagent = entry.subagent;
  const [expanded, setExpanded] = useState(false);

  const running = subagent.status === 'running';
  const isError = subagent.status === 'failed' || subagent.status === 'stopped';
  const description = subagent.description.trim() || subagent.name?.trim() || subagent.subagentType;
  const body = (subagent.error ?? '').trim() || (subagent.result ?? '').trim();
  const canOpen = Boolean(subagent.transcriptPayloadId) && Boolean(onOpenTranscript);

  return (
    <section className="agent-subagent-boundary" aria-label={`${labels.label} · ${description}`}>
      <div className="agent-subagent-line" aria-hidden="true" />
      <div className="agent-subagent-controls">
        {running ? (
          <div className="agent-subagent-toggle is-active" role="status">
            <LoaderIcon className="agent-tool-call-spinner" size={ICON_SIZE.tiny} />
            <CommandIcon size={ICON_SIZE.tiny} />
            <span>{labels.label}</span>
            <small className="agent-subagent-desc">{description}</small>
            <small>{labels.running}</small>
          </div>
        ) : (
          <button
            aria-expanded={expanded}
            className="agent-subagent-toggle"
            type="button"
            onClick={() => setExpanded((open) => !open)}
          >
            <ChevronDownIcon
              className={expanded ? 'agent-subagent-chevron is-expanded' : 'agent-subagent-chevron'}
              size={ICON_SIZE.tiny}
            />
            <CommandIcon size={ICON_SIZE.tiny} />
            <span>{labels.label}</span>
            <small className="agent-subagent-desc">{description}</small>
            <small className={isError ? 'is-error' : ''}>{statusLabel(subagent, labels)}</small>
          </button>
        )}
      </div>
      <div className="agent-subagent-line" aria-hidden="true" />
      {expanded ? (
        <div className="agent-subagent-summary">
          {body ? (
            <AgentMarkdown keyPrefix={`subagent-${subagent.id}`} text={body} />
          ) : (
            <p className="agent-subagent-empty">{labels.noResult}</p>
          )}
          {canOpen ? (
            <button
              className="agent-subagent-open"
              type="button"
              onClick={() => onOpenTranscript?.(subagent.id)}
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
