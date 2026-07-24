import type { CSSProperties } from 'react';
import type { TurnTokenUsage } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { formatNumber } from '../../ui/formatting';

interface ThreadUsageBreakdownProps {
  readonly usage: TurnTokenUsage;
}

export function ThreadUsageBreakdown({ usage }: ThreadUsageBreakdownProps) {
  const t = useT();
  const cost = usage.cost;
  const rows = [
    { cost: cost?.input, kind: 'input', label: t.agent.message.tokenLabels.input, tokens: usage.input },
    { cost: cost?.output, kind: 'output', label: t.agent.message.tokenLabels.output, tokens: usage.output },
    { cost: cost?.cacheRead, kind: 'cache-read', label: t.agent.message.tokenLabels.cacheRead, tokens: usage.cacheRead },
    { cost: cost?.cacheWrite, kind: 'cache-write', label: t.agent.message.tokenLabels.cacheWrite, tokens: usage.cacheWrite },
  ] as const;
  const cachedShare = formatCachedShare(usage.input, usage.cacheRead, usage.cacheWrite);
  return (
    <>
      <div className="thread-response-usage-title-row">
        <div className="thread-response-usage-title">{t.agent.message.usageDetails}</div>
        <div className="thread-response-usage-meta">
          {t.agent.message.cachedShare}: <strong>{cachedShare}</strong>
        </div>
      </div>
      <div aria-hidden className="thread-response-usage-bar">
        {rows.map((row) => (
          <span
            className={`is-${row.kind}`}
            key={row.kind}
            style={usageSegmentStyle(row.tokens, usage.totalTokens)}
          />
        ))}
      </div>
      <div aria-label={t.agent.message.usageDetails} className="thread-response-usage-breakdown">
        {[...rows, {
          cost: cost?.total,
          kind: 'total' as const,
          label: t.agent.message.tokenLabels.total,
          tokens: usage.totalTokens,
        }].map((row) => (
          <div
            className={`${row.kind === 'total' ? 'is-total' : ''}${row.tokens === 0 && !row.cost ? ' is-zero' : ''}`.trim() || undefined}
            key={row.kind}
          >
            <span><i className={`is-${row.kind}`} />{row.label}</span>
            <strong>{formatNumber(row.tokens)}</strong>
            <strong>{row.cost === undefined ? t.agent.message.usageUnavailable : formatUsageCost(row.cost)}</strong>
          </div>
        ))}
      </div>
    </>
  );
}

export function formatUsageCost(value: number): string {
  if (value <= 0) return '$0.0000';
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(4)}`;
}

export function formatCachedShare(input: number, cacheRead: number, cacheWrite: number): string {
  const inputContext = input + cacheRead + cacheWrite;
  if (inputContext <= 0) return '-';
  return `${Math.round((cacheRead / inputContext) * 100)}%`;
}

function usageSegmentStyle(value: number, total: number): CSSProperties {
  const share = total > 0 ? value / total : 0;
  return {
    '--segment-size': `${Math.max(share * 100, value > 0 ? 2 : 0)}%`,
  } as CSSProperties;
}
