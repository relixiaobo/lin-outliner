import { useRef, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AssistantMessage } from '../../../core/agentTypes';
import { useT } from '../../i18n/I18nProvider';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { formatNumber } from '../formatting';

export interface AgentUsageBreakdownValue {
  cacheRead?: number;
  cacheWrite?: number;
  cost?: {
    cacheRead?: number;
    cacheWrite?: number;
    input?: number;
    output?: number;
    total?: number;
  };
  input?: number;
  output?: number;
  totalTokens?: number;
}

export function formatUsageTokenValue(value: number | undefined): string {
  return Number.isFinite(value) && value !== undefined ? formatNumber(value) : '0';
}

export function formatUsageCostValue(value: number | undefined): string | null {
  if (!Number.isFinite(value) || value === undefined) return null;
  if (value <= 0) return '$0.0000';
  if (value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(4)}`;
}

export function formatUsageCachedShare(input: number | undefined, cacheRead: number | undefined, cacheWrite: number | undefined): string | null {
  const uncachedInput = input ?? 0;
  const read = cacheRead ?? 0;
  const write = cacheWrite ?? 0;
  const cacheActivity = read + write;
  const inputContext = uncachedInput + cacheActivity;
  if (cacheActivity <= 0 || inputContext <= 0) return null;
  return `${Math.round((read / inputContext) * 100)}%`;
}

function segmentStyle(value: number | undefined, total: number | undefined): CSSProperties {
  const safeValue = value ?? 0;
  const safeTotal = total ?? 0;
  const share = safeTotal > 0 ? safeValue / safeTotal : 0;
  return {
    '--segment-size': `${Math.max(share * 100, safeValue > 0 ? 2 : 0)}%`,
  } as CSSProperties;
}

export function AgentUsageBreakdown({ usage }: { usage: AgentUsageBreakdownValue }) {
  const t = useT();
  const cost = usage.cost;
  const cachedShare = formatUsageCachedShare(usage.input, usage.cacheRead, usage.cacheWrite);
  const usageRows = [
    { kind: 'input', label: t.agent.message.tokenLabels.input, tokens: usage.input, cost: cost?.input },
    { kind: 'output', label: t.agent.message.tokenLabels.output, tokens: usage.output, cost: cost?.output },
    { kind: 'cache-read', label: t.agent.message.tokenLabels.cacheRead, tokens: usage.cacheRead, cost: cost?.cacheRead },
    { kind: 'cache-write', label: t.agent.message.tokenLabels.cacheWrite, tokens: usage.cacheWrite, cost: cost?.cacheWrite },
  ];
  const breakdownRows = [
    ...usageRows,
    { kind: 'total', label: t.agent.message.tokenLabels.total, tokens: usage.totalTokens, cost: cost?.total },
  ];

  return (
    <>
      <div className="agent-message-usage-hover-title-row">
        <div className="agent-message-usage-hover-title">{t.agent.message.usageDetails}</div>
        {cachedShare ? (
          <div className="agent-message-usage-hover-meta">
            {t.agent.message.cachedShare}: <strong>{cachedShare}</strong>
          </div>
        ) : null}
      </div>
      <div className="agent-message-usage-hover-bar" aria-hidden>
        {usageRows.map((row) => (
          <span
            className={`is-${row.kind}`}
            key={row.kind}
            style={segmentStyle(row.tokens, usage.totalTokens)}
          />
        ))}
      </div>
      <div className="agent-message-usage-hover-breakdown" aria-label={t.agent.message.usageDetails}>
        {breakdownRows.map((row) => {
          const rowClassName = [
            row.kind === 'total' ? 'is-total' : null,
            (row.tokens ?? 0) === 0 && !row.cost ? 'is-zero' : null,
          ].filter(Boolean).join(' ') || undefined;
          return (
            <div className={rowClassName} key={row.kind}>
              <span>
                <i className={`is-${row.kind}`} />
                {row.label}
              </span>
              <strong>{formatUsageTokenValue(row.tokens)}</strong>
              <strong>{formatUsageCostValue(row.cost) ?? t.agent.message.usageUnavailable}</strong>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function AgentUsageHoverCard({
  anchorRef,
  usage,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  usage: AssistantMessage['usage'];
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const cost = usage.cost;
  const style = useAnchoredOverlay(cardRef, {
    anchorRef,
    gap: 8,
    layoutKey: `${usage.input}:${usage.output}:${usage.cacheRead}:${usage.cacheWrite}:${usage.totalTokens}:${cost?.total ?? 0}`,
    maxHeight: 280,
    placement: 'top-end',
    width: 248,
  });

  return createPortal(
    <div className="agent-message-usage-hover-card" ref={cardRef} role="tooltip" style={style}>
      <AgentUsageBreakdown usage={usage} />
    </div>,
    document.body,
  );
}
