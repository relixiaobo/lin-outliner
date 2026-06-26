import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { Messages } from '../../../core/i18n';
import type { AgentRunListEntry } from '../../api/types';
import { api } from '../../api/client';
import { useI18n } from '../../i18n/I18nProvider';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ICON_SIZE,
  LoaderIcon,
  StopIcon,
  WarningIcon,
} from '../icons';
import { CheckboxMark } from '../primitives/CheckboxMark';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';

interface AgentRunsPanelProps {
  error: string | null;
  loading: boolean;
  onOpenRun: (run: AgentRunListEntry) => void;
  onRefresh: () => void;
  runs: readonly AgentRunListEntry[];
}

interface AgentRunTreeNode {
  children: AgentRunTreeNode[];
  run: AgentRunListEntry;
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

function runStatusClass(run: AgentRunListEntry): string {
  return run.objectiveStatus ?? run.status;
}

function isCompletedRun(run: AgentRunListEntry): boolean {
  const status = runStatusClass(run);
  return status === 'completed' || status === 'verified';
}

function runDisplayTitle(run: AgentRunListEntry, labels: Messages['agent']['run']): string {
  if (run.purpose === 'verify') return labels.kind.verifier;
  return run.title;
}

function runChildProgressLabel(
  completed: number,
  total: number,
  labels: Messages['agent']['run'],
): string {
  return labels.childRunProgress({ completed, total });
}

export function AgentRunsPanel({
  error,
  loading,
  onOpenRun,
  onRefresh,
  runs,
}: AgentRunsPanelProps) {
  const { t } = useI18n();
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const autoExpandedRunIds = useRef(new Set<string>());
  const tree = useMemo(() => buildRunTree(runs), [runs]);

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

  function openRunFromRow(event: KeyboardEvent<HTMLElement>, run: AgentRunListEntry) {
    if (event.currentTarget !== event.target) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpenRun(run);
  }

  return (
    <section className="agent-run-panel" aria-label={t.agent.run.panelAriaLabel}>
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
            const title = runDisplayTitle(run, t.agent.run);
            const statusClass = runStatusClass(run);
            const completed = isCompletedRun(run);
            const completedChildCount = node.children.filter((child) => isCompletedRun(child.run)).length;
            const childProgress = hasChildren
              ? runChildProgressLabel(completedChildCount, node.children.length, t.agent.run)
              : null;
            const rowClassName = [
              'agent-run-row',
              `is-${run.status}`,
              `is-${statusClass}`,
              hasChildren ? 'has-children' : 'is-leaf',
              canStop ? 'has-actions' : '',
              expanded ? 'is-expanded' : '',
              node.depth > 0 ? 'is-subrun' : 'is-root-run',
            ].filter(Boolean).join(' ');
            return (
              <article
                aria-label={[title, childProgress].filter(Boolean).join(', ')}
                aria-expanded={hasChildren ? expanded : undefined}
                aria-level={node.depth + 1}
                className={rowClassName}
                key={run.runId}
                onClick={() => onOpenRun(run)}
                onKeyDown={(event) => openRunFromRow(event, run)}
                role="treeitem"
                style={{
                  '--run-depth': node.depth,
                  '--subrun-depth': Math.max(0, node.depth - 1),
                } as CSSProperties}
                tabIndex={0}
              >
                <span className={`agent-run-marker is-${statusClass}`} aria-hidden="true">
                  <CheckboxMark checked={completed} />
                </span>
                <span className="agent-run-main">
                  <span className="agent-run-title-row">
                    <span className="agent-run-title">{title}</span>
                  </span>
                  {hasChildren && childProgress ? (
                    <span className="agent-run-meta-row">
                      <button
                        aria-label={expanded ? t.agent.run.collapseRun : t.agent.run.expandRun}
                        className="agent-run-child-toggle"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpanded(run.runId);
                        }}
                        title={expanded ? t.agent.run.collapseRun : t.agent.run.expandRun}
                        type="button"
                      >
                        <span>{childProgress}</span>
                        {expanded ? <ChevronDownIcon size={ICON_SIZE.menu} /> : <ChevronRightIcon size={ICON_SIZE.menu} />}
                      </button>
                    </span>
                  ) : null}
                </span>
                {canStop ? (
                  <div className="agent-run-row-actions">
                    <IconButton
                      className="agent-run-icon-button is-danger"
                      disabled={stoppingRunId !== null}
                      icon={StopIcon}
                      label={stopping ? t.agent.run.stopping : t.agent.run.stopRun}
                      onClick={(event) => {
                        event.stopPropagation();
                        void stopRun(run);
                      }}
                      title={stopping ? t.agent.run.stopping : t.agent.run.stopRun}
                      variant="message"
                    />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
