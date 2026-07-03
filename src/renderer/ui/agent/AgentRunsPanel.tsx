import { useMemo, useState } from 'react';
import type { AgentRunListEntry } from '../../api/types';
import { api } from '../../api/client';
import { useI18n } from '../../i18n/I18nProvider';
import {
  ICON_SIZE,
  LoaderIcon,
  StopIcon,
  WarningIcon,
} from '../icons';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
import { AgentRunRow, displayRunStatus, isCompletedRunStatus, type AgentRunRowData } from './AgentRunRow';

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
  // Mirrors the main-process ranking: a blocked objective is a parked run that
  // needs triage, so it sorts just under live runs even when its status is
  // 'completed' (verification-rejected). Keying only off status would bury it.
  if (run.objectiveStatus === 'blocked') return 1;
  if (run.status === 'running') return 0;
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

function isCompletedRun(run: AgentRunListEntry): boolean {
  return isCompletedRunStatus(displayRunStatus(run));
}

function rowDataFromRun(run: AgentRunListEntry, children: readonly AgentRunTreeNode[], title: string): AgentRunRowData {
  return {
    runId: run.runId,
    title,
    status: run.status,
    objectiveStatus: run.objectiveStatus,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    childRunCount: children.length,
    completedChildRunCount: children.filter((child) => isCompletedRun(child.run)).length,
  };
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
  const tree = useMemo(() => buildRunTree(runs), [runs]);

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
        <div className="agent-run-list" aria-label={t.agent.run.treeAriaLabel}>
          {tree.map((node) => {
            const { run } = node;
            const canStop = run.status === 'running' && run.kind === 'delegation' && run.purpose !== 'verify';
            const stopping = stoppingRunId === run.runId;
            const title = run.purpose === 'verify' ? t.agent.run.kind.verifier : run.title;
            return (
              <AgentRunRow
                action={canStop ? (
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
                ) : null}
                key={run.runId}
                onOpen={() => onOpenRun(run)}
                run={rowDataFromRun(run, node.children, title)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
