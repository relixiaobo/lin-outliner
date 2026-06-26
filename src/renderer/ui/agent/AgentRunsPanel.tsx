import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Messages } from '../../../core/i18n';
import type { AgentRunListEntry } from '../../api/types';
import { api } from '../../api/client';
import { useI18n } from '../../i18n/I18nProvider';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  ICON_SIZE,
  LoaderIcon,
  OpenIcon,
  RefreshIcon,
  StopIcon,
  UsedToolsIcon,
  WarningIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { CheckboxMark } from '../primitives/CheckboxMark';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';

interface AgentRunsPanelProps {
  error: string | null;
  loading: boolean;
  onClose: () => void;
  onOpenRun: (run: AgentRunListEntry) => void;
  onRefresh: () => void;
  runs: readonly AgentRunListEntry[];
}

interface AgentRunTreeNode {
  children: AgentRunTreeNode[];
  run: AgentRunListEntry;
}

function formatRunTime(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function runStatusRank(run: AgentRunListEntry): number {
  if (run.status === 'running' && run.objectiveStatus !== 'blocked') return 0;
  if (run.status === 'running') return 1;
  if (run.status === 'failed') return 2;
  if (run.status === 'stopped') return 3;
  return 4;
}

function compareRuns(left: AgentRunListEntry, right: AgentRunListEntry): number {
  return runStatusRank(left) - runStatusRank(right)
    || right.updatedAt - left.updatedAt
    || left.runId.localeCompare(right.runId);
}

function buildRunTree(runs: readonly AgentRunListEntry[]): AgentRunTreeNode[] {
  const nodes = new Map<string, AgentRunTreeNode>();
  for (const run of runs) nodes.set(run.runId, { run, children: [] });
  const roots: AgentRunTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.run.parentRunId ? nodes.get(node.run.parentRunId) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortTree = (items: AgentRunTreeNode[]) => {
    items.sort((left, right) => compareRuns(left.run, right.run));
    for (const item of items) sortTree(item.children);
  };
  sortTree(roots);
  return roots;
}

function flattenTree(nodes: readonly AgentRunTreeNode[], expanded: ReadonlySet<string>, depth = 0): Array<AgentRunTreeNode & { depth: number }> {
  const rows: Array<AgentRunTreeNode & { depth: number }> = [];
  for (const node of nodes) {
    rows.push({ ...node, depth });
    if (node.children.length > 0 && expanded.has(node.run.runId)) {
      rows.push(...flattenTree(node.children, expanded, depth + 1));
    }
  }
  return rows;
}

function runStatusLabel(run: AgentRunListEntry, labels: Messages['agent']['run']): string {
  if (run.objectiveStatus === 'verified') return labels.status.verified;
  if (run.objectiveStatus === 'blocked') return labels.status.blocked;
  if (run.objectiveStatus === 'budget_exhausted') return labels.status.budgetExhausted;
  if (run.objectiveStatus === 'verifying') return labels.status.verifying;
  return labels.status[run.status];
}

function runKindLabel(run: AgentRunListEntry, labels: Messages['agent']['run']): string {
  if (run.purpose === 'verify') return labels.kind.verifier;
  return labels.kind[run.kind];
}

function runMetaParts(run: AgentRunListEntry, locale: string, labels: Messages['agent']['run']): string[] {
  return [
    run.conversationTitle ?? labels.unknownConversation,
    runKindLabel(run, labels),
    runStatusLabel(run, labels),
    formatRunTime(run.updatedAt, locale),
  ];
}

export function AgentRunsPanel({
  error,
  loading,
  onClose,
  onOpenRun,
  onRefresh,
  runs,
}: AgentRunsPanelProps) {
  const { locale, t } = useI18n();
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const autoExpandedRunIds = useRef(new Set<string>());
  const tree = useMemo(() => buildRunTree(runs), [runs]);
  const runningCount = useMemo(() => runs.filter((run) => run.status === 'running').length, [runs]);

  useEffect(() => {
    setExpandedRunIds((previous) => {
      let next = previous;
      for (const root of tree) {
        if (root.children.length === 0 || root.run.status !== 'running') continue;
        if (autoExpandedRunIds.current.has(root.run.runId)) continue;
        autoExpandedRunIds.current.add(root.run.runId);
        if (next === previous) next = new Set(previous);
        next.add(root.run.runId);
      }
      return next;
    });
  }, [tree]);

  const visibleRows = useMemo(() => flattenTree(tree, expandedRunIds), [tree, expandedRunIds]);

  async function stopRun(run: AgentRunListEntry) {
    if (run.status !== 'running' || stoppingRunId) return;
    setStoppingRunId(run.runId);
    setActionError(null);
    try {
      await api.agentRunStop(run.conversationId, run.runId);
      onRefresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStoppingRunId(null);
    }
  }

  function toggleExpanded(runId: string) {
    setExpandedRunIds((previous) => {
      const next = new Set(previous);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  return (
    <section className="agent-run-panel" aria-label={t.agent.run.panelAriaLabel}>
      <header className="agent-run-header">
        <div className="agent-run-title-block">
          <div className="agent-run-title-line">
            <UsedToolsIcon size={ICON_SIZE.menu} />
            <span>{t.agent.run.heading}</span>
          </div>
          <p aria-live="polite">{runningCount > 0 ? t.agent.run.runningSummary({ count: runningCount }) : t.agent.run.idleSummary}</p>
        </div>
        <div className="agent-run-header-actions">
          <IconButton
            className="agent-run-icon-button"
            disabled={loading}
            icon={RefreshIcon}
            label={t.agent.run.refresh}
            onClick={onRefresh}
            title={t.agent.run.refresh}
            variant="panel"
          />
          <IconButton
            className="agent-run-close"
            icon={CloseIcon}
            label={t.agent.run.closePanel}
            onClick={onClose}
            title={t.agent.run.close}
            variant="panel"
          />
        </div>
      </header>
      {actionError ? (
        <div className="agent-run-action-error" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{actionError}</span>
        </div>
      ) : null}
      {error ? (
        <ErrorState
          className="agent-run-empty"
          message={error}
          onRetry={onRefresh}
          retryLabel={t.agent.run.refresh}
        />
      ) : loading && runs.length === 0 ? (
        <EmptyState
          className="agent-run-empty"
          icon={LoaderIcon}
          iconClassName="agent-tool-call-spinner"
          loading
          role="status"
          title={t.agent.run.loading}
        />
      ) : runs.length === 0 ? (
        <div className="agent-run-empty">{t.agent.run.empty}</div>
      ) : (
        <div className="agent-run-list" role="tree" aria-label={t.agent.run.treeAriaLabel}>
          {visibleRows.map((node) => {
            const { run } = node;
            const canStop = run.status === 'running';
            const stopping = stoppingRunId === run.runId;
            const expanded = expandedRunIds.has(run.runId);
            const hasChildren = node.children.length > 0;
            const meta = runMetaParts(run, locale, t.agent.run).join(' · ');
            const statusClass = run.objectiveStatus ?? run.status;
            const completed = statusClass === 'completed' || statusClass === 'verified';
            const rowClassName = [
              'agent-run-row',
              `is-${run.status}`,
              `is-${statusClass}`,
              hasChildren ? 'has-children' : 'is-leaf',
              expanded ? 'is-expanded' : '',
              node.depth > 0 ? 'is-subrun' : 'is-root-run',
            ].filter(Boolean).join(' ');
            return (
              <article
                aria-expanded={hasChildren ? expanded : undefined}
                aria-level={node.depth + 1}
                className={rowClassName}
                key={run.runId}
                role="treeitem"
                style={{
                  '--run-depth': node.depth,
                  '--subrun-depth': Math.max(0, node.depth - 1),
                } as CSSProperties}
              >
                <span className={`agent-run-marker is-${statusClass}`} aria-hidden="true">
                  <CheckboxMark checked={completed} />
                </span>
                <ButtonControl
                  className="agent-run-main"
                  onClick={() => onOpenRun(run)}
                >
                  <span className="agent-run-title-row">
                    <span className="agent-run-title">{run.title}</span>
                  </span>
                  <span className="agent-run-meta">{meta}</span>
                </ButtonControl>
                {hasChildren ? (
                  <button
                    aria-label={expanded ? t.agent.run.collapseRun : t.agent.run.expandRun}
                    className="agent-run-disclosure"
                    onClick={() => toggleExpanded(run.runId)}
                    title={expanded ? t.agent.run.collapseRun : t.agent.run.expandRun}
                    type="button"
                  >
                    {expanded ? <ChevronDownIcon size={ICON_SIZE.menu} /> : <ChevronRightIcon size={ICON_SIZE.menu} />}
                  </button>
                ) : null}
                <div className="agent-run-row-actions">
                  <IconButton
                    className="agent-run-icon-button"
                    icon={OpenIcon}
                    label={t.agent.run.openRun}
                    onClick={() => onOpenRun(run)}
                    title={t.agent.run.openRun}
                    variant="message"
                  />
                  {canStop ? (
                    <IconButton
                      className="agent-run-icon-button is-danger"
                      disabled={stoppingRunId !== null}
                      icon={StopIcon}
                      label={stopping ? t.agent.run.stopping : t.agent.run.stopRun}
                      onClick={() => void stopRun(run)}
                      title={stopping ? t.agent.run.stopping : t.agent.run.stopRun}
                      variant="message"
                    />
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
